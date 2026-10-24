import { createClient } from "jsr:@supabase/supabase-js@2";

// billing-portal: opens Dodo's hosted page where a subscriber can update their card or cancel.
// The browser sends nothing; we look up the caller's own billing account from the database.

const isLive = () => Deno.env.get("DODO_ENV") === "live_mode"; // read per request; anything else is test mode
const dodoBase = () => (isLive() ? "https://live.dodopayments.com" : "https://test.dodopayments.com");
const siteUrl = () => (Deno.env.get("SITE_URL") || "").trim().replace(/\/+$/, "");

function corsHeaders(req: Request): Record<string, string> {
  const extra = (Deno.env.get("ALLOWED_ORIGINS") || "").split(",").map((s) => s.trim().replace(/\/+$/, "")).filter(Boolean);
  const allowed = [siteUrl(), ...extra, ...(isLive() ? [] : ["http://localhost:5173"])].filter(Boolean);
  const origin = req.headers.get("Origin") || "";
  const h: Record<string, string> = {
    "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Vary": "Origin",
  };
  if (allowed.includes(origin)) h["Access-Control-Allow-Origin"] = origin;
  return h;
}
const reply = (req: Request, body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { ...corsHeaders(req), "Content-Type": "application/json" } });
const unavailable = (req: Request) =>
  reply(req, { error: "Billing isn't available right now. Please try again in a moment.", code: "unavailable" }, 503);

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: corsHeaders(req) });
  if (req.method !== "POST") return reply(req, { error: "Method not allowed" }, 405);

  const auth = req.headers.get("Authorization");
  if (!auth) return reply(req, { error: "Please sign in again.", code: "unauthorized" }, 401);

  const apiKey = Deno.env.get("DODO_PAYMENTS_API_KEY");
  const site = siteUrl();
  if (!apiKey || !site) { console.error("billing-portal: missing DODO_PAYMENTS_API_KEY or SITE_URL"); return unavailable(req); }

  try {
    const url = Deno.env.get("SUPABASE_URL")!;
    const userClient = createClient(url, Deno.env.get("SUPABASE_ANON_KEY")!, { global: { headers: { Authorization: auth } } });
    const admin = createClient(url, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);

    const { data: { user } } = await userClient.auth.getUser();
    if (!user) return reply(req, { error: "Please sign in again.", code: "unauthorized" }, 401);

    const { data: sub } = await admin.from("subscriptions").select("provider,provider_customer_id").eq("user_id", user.id).maybeSingle();
    if (!sub || sub.provider !== "dodo" || !sub.provider_customer_id) {
      return reply(req, { error: "We couldn't find a billing account to manage yet.", code: "no_subscription" }, 404);
    }

    const endpoint = `${dodoBase()}/customers/${encodeURIComponent(sub.provider_customer_id)}/customer-portal/session?return_url=${encodeURIComponent(`${site}/settings/account`)}`;
    const res = await fetch(endpoint, { method: "POST", headers: { Authorization: `Bearer ${apiKey}` }, signal: AbortSignal.timeout(15000) });
    if (!res.ok) { console.error(`billing-portal: Dodo returned ${res.status}`); return unavailable(req); }
    const out = await res.json();
    let link: URL;
    try { link = new URL(String(out.link)); } catch { link = new URL("about:blank"); }
    if (link.protocol !== "https:" || !/(^|\.)dodopayments\.com$/.test(link.hostname)) { console.error("billing-portal: unexpected link from Dodo"); return unavailable(req); }
    return reply(req, { url: link.toString() });
  } catch (err) {
    console.error("billing-portal: unexpected error:", (err as Error).message);
    return unavailable(req);
  }
});
