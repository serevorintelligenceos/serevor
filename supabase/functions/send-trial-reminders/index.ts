import { createClient } from "jsr:@supabase/supabase-js@2";
import { buildTrialEndingEmail } from "./email.ts";

// ---------------------------------------------------------------------------
// send-trial-reminders: emails each trial owner ~2 days before the trial ends.
// Called hourly by a database job. Access is gated by a shared secret that lives only in the
// database (Vault) and is verified there, so no person ever handles it.
// Each reminder is claimed in billing_emails first, so nobody is emailed twice.
// Deployed with verify_jwt = false (the caller is the database job, not a signed-in user).
// ---------------------------------------------------------------------------

const MAX_PER_RUN = 20;   // well under Resend's free 100/day limit
const GAP_MS = 600;       // Resend allows 2 requests per second
const json = (b: unknown, s = 200) => new Response(JSON.stringify(b), { status: s, headers: { "Content-Type": "application/json" } });
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const EMAIL = /^[^\s@<>"']+@[^\s@<>"']+\.[^\s@<>"']+$/;

interface SendResult { ok: boolean; status: number; id?: string; text?: string }
async function sendViaResend(apiKey: string, p: { from: string; to: string; subject: string; html: string; text: string; replyTo: string }, idemKey: string): Promise<SendResult> {
  try {
    const res = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json", "Idempotency-Key": idemKey },
      body: JSON.stringify({ from: p.from, to: [p.to], subject: p.subject, html: p.html, text: p.text, reply_to: p.replyTo }),
      signal: AbortSignal.timeout(15000),
    });
    const raw = await res.text();
    let id: string | undefined;
    try { id = JSON.parse(raw)?.id; } catch { /* not JSON */ }
    return { ok: res.ok, status: res.status, id, text: raw.slice(0, 300) };
  } catch (e) {
    return { ok: false, status: 0, text: (e as Error).message };
  }
}

Deno.serve(async (req: Request) => {
  if (req.method !== "POST") return json({ error: "method_not_allowed" }, 405);

  const admin = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);

  const { data: authorised } = await admin.rpc("billing_check_cron_secret", { p_secret: req.headers.get("x-cron-secret") ?? "" });
  if (authorised !== true) return json({ error: "unauthorized" }, 401);

  const apiKey = Deno.env.get("RESEND_API_KEY");
  const site = (Deno.env.get("SITE_URL") || "").trim().replace(/\/+$/, "");
  if (!apiKey || !/^https:\/\/|^http:\/\/localhost/.test(site)) {
    console.error("send-trial-reminders: RESEND_API_KEY or SITE_URL is not set");
    return json({ error: "not_configured" }, 503);
  }
  const from = Deno.env.get("RESEND_FROM") || "Serevor <onboarding@resend.dev>";
  const support = Deno.env.get("SUPPORT_EMAIL") || "support.nexora.app@gmail.com";

  // deno-lint-ignore no-explicit-any
  let body: any = {};
  try { body = await req.json(); } catch { /* the hourly job sends an empty object */ }

  // ---- test mode: send ONE sample email to an address, touching no records ----
  if (body && typeof body.test_to === "string") {
    if (!EMAIL.test(body.test_to)) return json({ error: "invalid_test_address" }, 400);
    const sample = buildTrialEndingEmail({ trialEndsAt: new Date(Date.now() + 2 * 86400000).toISOString(), interval: "year", siteUrl: site, supportEmail: support });
    if (!sample) return json({ error: "template_failed" }, 500);
    const r = await sendViaResend(apiKey, { from, to: body.test_to, subject: `[TEST] ${sample.subject}`, html: sample.html, text: sample.text, replyTo: support }, `test/${crypto.randomUUID()}`);
    console.log(`send-trial-reminders test -> ${r.status}`);
    return json({ test: true, sent: r.ok, status: r.status, id: r.id ?? null, detail: r.ok ? null : r.text }, r.ok ? 200 : 502);
  }

  // ---- real run ----
  const { data: due, error: dueErr } = await admin.rpc("billing_due_trial_reminders", { p_limit: MAX_PER_RUN });
  if (dueErr) { console.error("send-trial-reminders: could not list reminders:", dueErr.message); return json({ error: "list_failed" }, 500); }

  const out = { due: (due ?? []).length, sent: 0, failed: 0, skipped: 0, stopped: null as string | null };
  let first = true;
  // deno-lint-ignore no-explicit-any
  for (const row of (due ?? []) as any[]) {
    if (out.stopped) break;

    // Claim first. A row already sent (or being sent a moment ago, or retried 3 times) is skipped.
    let claimId: string; let attempts = 1;
    const ins = await admin.from("billing_emails").insert({ user_id: row.user_id, subscription_id: row.subscription_id, kind: "trial_ending" }).select("id").single();
    if (ins.error) {
      if (ins.error.code !== "23505") { console.error("send-trial-reminders: claim failed:", ins.error.message); out.failed++; continue; }
      const { data: ex } = await admin.from("billing_emails").select("id,status,attempts,created_at")
        .eq("subscription_id", row.subscription_id).eq("kind", "trial_ending").single();
      if (!ex || ex.status === "sent" || ex.attempts >= 3 || (ex.status === "sending" && Date.now() - Date.parse(ex.created_at) < 15 * 60 * 1000)) { out.skipped++; continue; }
      attempts = (ex.attempts ?? 0) + 1;
      await admin.from("billing_emails").update({ status: "sending", attempts }).eq("id", ex.id);
      claimId = ex.id;
    } else {
      claimId = ins.data.id;
    }

    const mail = buildTrialEndingEmail({ trialEndsAt: row.trial_ends_at, interval: row.billing_interval, siteUrl: site, supportEmail: support });
    if (!mail) {
      await admin.from("billing_emails").update({ status: "failed", attempts: 3, error: "bad_date" }).eq("id", claimId);
      out.failed++; continue;
    }

    if (!first) await sleep(GAP_MS);
    first = false;
    const r = await sendViaResend(apiKey, { from, to: row.email, subject: mail.subject, html: mail.html, text: mail.text, replyTo: support }, `trial-ending/${row.subscription_id}`);

    if (r.ok) {
      await admin.from("billing_emails").update({ status: "sent", sent_at: new Date().toISOString(), resend_id: r.id ?? null, error: null }).eq("id", claimId);
      out.sent++;
    } else if (r.status === 403 && /testing emails|own email|domain/i.test(r.text ?? "")) {
      // The sending domain is not verified yet. Not the customer's fault: do not use up a retry.
      await admin.from("billing_emails").update({ status: "failed", attempts: attempts - 1, error: "domain_not_verified" }).eq("id", claimId);
      out.failed++;
    } else if (r.status === 429) {
      await admin.from("billing_emails").update({ status: "failed", attempts: attempts - 1, error: "rate_limited" }).eq("id", claimId);
      out.failed++; out.stopped = "rate_limited"; // out of quota for today: stop and retry next hour
    } else {
      await admin.from("billing_emails").update({ status: "failed", error: `${r.status}: ${(r.text ?? "").slice(0, 150)}` }).eq("id", claimId);
      out.failed++;
    }
  }
  console.log(`send-trial-reminders due=${out.due} sent=${out.sent} failed=${out.failed} skipped=${out.skipped}`);
  return json(out);
});
