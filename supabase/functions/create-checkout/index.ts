import { createClient } from "jsr:@supabase/supabase-js@2";

// ---------------------------------------------------------------------------
// create-checkout: starts a Pro checkout. The browser sends ONLY "month" or "year".
// Product, price, currency and trial are decided here, on the server.
// ---------------------------------------------------------------------------

// Read on every request (not once at startup) so changing a secret takes effect immediately.
const trialDays = () => Math.max(0, Math.min(30, Number(Deno.env.get("TRIAL_DAYS") ?? "7") || 0)); // keep equal to TRIAL_DAYS in src/lib/billing/plans.js
const isLive = () => Deno.env.get("DODO_ENV") === "live_mode"; // anything else is test mode: no accidental live charges
const dodoBase = () => (isLive() ? "https://live.dodopayments.com" : "https://test.dodopayments.com");
const siteUrl = () => (Deno.env.get("SITE_URL") || "").trim().replace(/\/+$/, "");

function allowedOrigins(): string[] {
  const extra = (Deno.env.get("ALLOWED_ORIGINS") || "").split(",").map((s) => s.trim().replace(/\/+$/, "")).filter(Boolean);
  return [siteUrl(), ...extra, ...(isLive() ? [] : ["http://localhost:5173"])].filter(Boolean);
}
function corsHeaders(req: Request): Record<string, string> {
  const origin = req.headers.get("Origin") || "";
  const h: Record<string, string> = {
    "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Vary": "Origin",
  };
  if (allowedOrigins().includes(origin)) h["Access-Control-Allow-Origin"] = origin;
  return h;
}
const reply = (req: Request, body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { ...corsHeaders(req), "Content-Type": "application/json" } });
const unavailable = (req: Request) =>
  reply(req, { error: "Checkout isn't available right now. You haven't been charged.", code: "unavailable" }, 503);

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: corsHeaders(req) });
  if (req.method !== "POST") return reply(req, { error: "Method not allowed" }, 405);

  const auth = req.headers.get("Authorization");
  if (!auth) return reply(req, { error: "Please sign in again.", code: "unauthorized" }, 401);

  const apiKey = Deno.env.get("DODO_PAYMENTS_API_KEY");
  const products = { month: Deno.env.get("DODO_PRODUCT_MONTHLY"), year: Deno.env.get("DODO_PRODUCT_ANNUAL") };
  const site = siteUrl();
  if (!apiKey || !products.month || !products.year || !/^https:\/\/|^http:\/\/localhost/.test(site)) {
    console.error("create-checkout: missing DODO_PAYMENTS_API_KEY, product ids or SITE_URL");
    return unavailable(req);
  }

  let body: { interval?: unknown };
  try { body = await req.json(); } catch { return reply(req, { error: "Invalid request", code: "bad_request" }, 400); }
  const interval = body.interval;
  if (interval !== "month" && interval !== "year") return reply(req, { error: "Invalid plan", code: "bad_request" }, 400);

  try {
    const url = Deno.env.get("SUPABASE_URL")!;
    const userClient = createClient(url, Deno.env.get("SUPABASE_ANON_KEY")!, { global: { headers: { Authorization: auth } } });
    const admin = createClient(url, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);

    const { data: { user } } = await userClient.auth.getUser();
    if (!user) return reply(req, { error: "Please sign in again.", code: "unauthorized" }, 401);

    // Already Pro? Do not sell a second subscription.
    const { data: isPro, error: proErr } = await admin.rpc("billing_is_pro", { p_user: user.id });
    if (proErr) { console.error("create-checkout: pro check failed:", proErr.message); return unavailable(req); }
    if (isPro) return reply(req, { error: "You're already on Pro.", code: "already_subscribed" }, 409);

    // Rate limit: at most 5 checkout attempts per 10 minutes per user.
    const since = new Date(Date.now() - 10 * 60 * 1000).toISOString();
    const { count, error: cntErr } = await admin.from("checkout_sessions")
      .select("id", { count: "exact", head: true }).eq("user_id", user.id).gte("created_at", since);
    if (cntErr) { console.error("create-checkout: rate check failed:", cntErr.message); return unavailable(req); }
    if ((count ?? 0) >= 5) return reply(req, { error: "Too many attempts. Please wait a few minutes.", code: "rate_limited" }, 429);

    // Our own record FIRST. The webhook later links the payment to the user through this row.
    const { data: row, error: insErr } = await admin.from("checkout_sessions")
      .insert({ user_id: user.id, provider: "dodo", plan_tier: "pro", billing_interval: interval, currency: "USD" })
      .select("id").single();
    if (insErr || !row) { console.error("create-checkout: could not create session row:", insErr?.message); return unavailable(req); }

    const payload: Record<string, unknown> = {
      product_cart: [{ product_id: interval === "year" ? products.year : products.month, quantity: 1 }],
      return_url: `${site}/upgrade/done`,
      cancel_url: `${site}/upgrade`,
      metadata: { checkout_session_id: row.id },
      feature_flags: { redirect_immediately: true },
    };
    if (user.email) payload.customer = { email: user.email };
    const days = trialDays();
    if (days > 0) payload.subscription_data = { trial_period_days: days };

    const res = await fetch(`${dodoBase()}/checkouts`, {
      method: "POST",
      headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(15000),
    });
    if (!res.ok) {
      console.error(`create-checkout: Dodo returned ${res.status}: ${(await res.text()).slice(0, 300)}`);
      await admin.from("checkout_sessions").update({ status: "failed" }).eq("id", row.id);
      return unavailable(req);
    }
    const out = await res.json();
    let checkoutUrl: URL;
    try { checkoutUrl = new URL(String(out.checkout_url)); } catch { checkoutUrl = new URL("about:blank"); }
    if (checkoutUrl.protocol !== "https:" || !/(^|\.)dodopayments\.com$/.test(checkoutUrl.hostname) || typeof out.session_id !== "string") {
      console.error("create-checkout: unexpected response from Dodo");
      await admin.from("checkout_sessions").update({ status: "failed" }).eq("id", row.id);
      return unavailable(req);
    }
    await admin.from("checkout_sessions").update({ provider_ref: out.session_id }).eq("id", row.id);
    return reply(req, { url: checkoutUrl.toString() });
  } catch (err) {
    console.error("create-checkout: unexpected error:", (err as Error).message);
    return unavailable(req);
  }
});
