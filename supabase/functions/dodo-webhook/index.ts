import { createClient } from "jsr:@supabase/supabase-js@2";
import { normalizeSubscriptionEvent, verifyWebhook } from "./logic.ts";

// ---------------------------------------------------------------------------
// dodo-webhook: the ONLY thing that turns Pro on or off.
//   1. verify Dodo's signature on the raw body (reject everything else)
//   2. record the event once (idempotent: Dodo retries and may repeat)
//   3. link it to a user through OUR server-created checkout record (never trust client data)
//   4. apply it atomically in the database (ordered, duplicate-safe)
// Deployed with verify_jwt = false (Dodo has no Supabase login); the signature is the lock.
// ---------------------------------------------------------------------------

const json = (b: unknown, s = 200) =>
  new Response(JSON.stringify(b), { status: s, headers: { "Content-Type": "application/json" } });

// deno-lint-ignore no-explicit-any
async function audit(admin: any, userId: string | null, action: string, details: Record<string, unknown>) {
  try { await admin.from("billing_audit").insert({ user_id: userId, action, details }); }
  catch (e) { console.error("audit failed:", (e as Error).message); }
}

// deno-lint-ignore no-explicit-any
async function resolveUser(admin: any, v: { subscriptionId: string; checkoutSessionId: string | null }) {
  const { data: existing } = await admin.from("subscriptions").select("user_id")
    .eq("provider", "dodo").eq("provider_subscription_id", v.subscriptionId).maybeSingle();
  let session: { id: string; user_id: string } | null = null;
  if (v.checkoutSessionId) {
    const { data } = await admin.from("checkout_sessions").select("id,user_id")
      .eq("id", v.checkoutSessionId).eq("provider", "dodo").maybeSingle();
    session = data;
  }
  if (existing && session && existing.user_id !== session.user_id) {
    await audit(admin, existing.user_id, "dodo_user_mismatch", { subscription_id: v.subscriptionId });
  }
  if (existing) return { userId: existing.user_id as string, sessionId: session?.id ?? null };
  if (session) return { userId: session.user_id, sessionId: session.id };
  return null;
}

Deno.serve(async (req: Request) => {
  if (req.method !== "POST") return json({ error: "method_not_allowed" }, 405);

  const secret = Deno.env.get("DODO_WEBHOOK_SECRET");
  if (!secret) { console.error("dodo-webhook: DODO_WEBHOOK_SECRET is not set"); return json({ error: "not_configured" }, 503); }

  const raw = await req.text(); // the exact bytes Dodo signed
  if (raw.length > 1_000_000) return json({ error: "too_large" }, 413);

  const id = req.headers.get("webhook-id");
  const ts = req.headers.get("webhook-timestamp");
  const valid = await verifyWebhook({ secret, id, timestamp: ts, signature: req.headers.get("webhook-signature"), body: raw });
  if (!valid || !id) return json({ error: "invalid_signature" }, 401);

  // deno-lint-ignore no-explicit-any
  let evt: any;
  try { evt = JSON.parse(raw); } catch { return json({ error: "invalid_json" }, 400); }
  const type: string = typeof evt?.type === "string" ? evt.type : "unknown";

  const admin = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);

  // ---- idempotency: record once; skip events we already handled ----
  let rowId: string;
  const ins = await admin.from("webhook_events")
    .insert({ provider: "dodo", event_id: id, event_type: type.slice(0, 100), payload: evt }).select("id").single();
  if (ins.error) {
    if (ins.error.code !== "23505") { console.error("dodo-webhook: could not store event:", ins.error.message); return json({ error: "storage_failed" }, 500); }
    const { data: ex } = await admin.from("webhook_events").select("id,status,attempts")
      .eq("provider", "dodo").eq("event_id", id).single();
    if (!ex) return json({ error: "storage_failed" }, 500);
    if (ex.status === "processed" || ex.status === "ignored") return json({ received: true, duplicate: true });
    rowId = ex.id;
    await admin.from("webhook_events").update({ attempts: (ex.attempts ?? 1) + 1, status: "received", error: null }).eq("id", rowId);
  } else {
    rowId = ins.data.id;
  }
  const finish = (status: "processed" | "ignored" | "failed", error?: string) =>
    admin.from("webhook_events").update({ status, error: error ? error.slice(0, 500) : null, processed_at: new Date().toISOString() }).eq("id", rowId);

  try {
    // ---- subscription lifecycle ----
    if (type.startsWith("subscription.")) {
      const norm = normalizeSubscriptionEvent(
        evt,
        { monthly: Deno.env.get("DODO_PRODUCT_MONTHLY") || undefined, annual: Deno.env.get("DODO_PRODUCT_ANNUAL") || undefined },
        Date.now(), ts,
      );
      if (!norm.ok) {
        await audit(admin, null, "dodo_event_rejected", { type, reason: norm.reason, subscription_id: evt?.data?.subscription_id ?? null });
        if (norm.reason === "missing_period_end" || norm.reason === "products_not_configured") {
          await finish("failed", norm.reason); // ask Dodo to retry rather than lose a paying customer's upgrade
          return json({ error: norm.reason }, 500);
        }
        await finish("ignored", norm.reason);
        return json({ received: true, ignored: norm.reason });
      }
      const v = norm.value;
      const who = await resolveUser(admin, v);
      if (!who) {
        await audit(admin, null, "dodo_unlinked_subscription", { subscription_id: v.subscriptionId, product_id: v.productId });
        await finish("ignored", "unlinked_subscription");
        return json({ received: true, ignored: "unlinked_subscription" });
      }
      const { data: result, error } = await admin.rpc("billing_apply_subscription", {
        p_user: who.userId, p_provider: "dodo", p_sub_id: v.subscriptionId, p_customer_id: v.customerId,
        p_status: v.status, p_interval: v.interval, p_period_end: v.periodEnd,
        p_cancel_at_period_end: v.cancelAtPeriodEnd, p_cancelled_at: v.cancelledAt,
        p_currency: v.currency, p_event_at: v.eventAt, p_trial_days: v.trialDays,
      });
      if (error) throw new Error(`apply failed: ${error.message}`);
      if (result === "applied" && who.sessionId) {
        await admin.from("checkout_sessions").update({ status: "completed", completed_at: new Date().toISOString() })
          .eq("id", who.sessionId).eq("status", "created");
      }
      if (result !== "applied" && result !== "stale") {
        await audit(admin, who.userId, `dodo_${result}`, { subscription_id: v.subscriptionId, type });
      }
      console.log(`dodo-webhook ${type} -> ${result}`);
      await finish("processed");
      return json({ received: true, result });
    }

    // ---- payments ledger: lets a refund be traced to its subscription, even months later (ids and amounts only) ----
    if (type === "payment.succeeded") {
      const d = evt?.data ?? {};
      if (typeof d.payment_id === "string" && typeof d.subscription_id === "string") {
        const total = Number(d.total_amount);
        const { error } = await admin.from("billing_payments").upsert({
          provider: "dodo", payment_id: d.payment_id, subscription_id: d.subscription_id,
          total_amount: Number.isFinite(total) ? total : null,
          currency: typeof d.currency === "string" ? d.currency.slice(0, 3).toUpperCase() : null,
        }, { onConflict: "provider,payment_id", ignoreDuplicates: true });
        if (error) throw new Error(`ledger failed: ${error.message}`);
      }
      await finish("processed");
      return json({ received: true });
    }

    // ---- refunds: a refunded subscription loses access immediately and permanently ----
    if (type === "refund.succeeded") {
      const d = evt?.data ?? {};
      const paymentId: string | null = typeof d.payment_id === "string" ? d.payment_id : null;
      let subId: string | null = typeof d.subscription_id === "string" ? d.subscription_id : null;
      let paidTotal: number | null = null;
      let paidCur: string | null = null;
      if (paymentId) {
        const { data: pay } = await admin.from("billing_payments").select("subscription_id,total_amount,currency")
          .eq("provider", "dodo").eq("payment_id", paymentId).maybeSingle();
        if (pay) { subId = subId ?? pay.subscription_id ?? null; paidTotal = pay.total_amount ?? null; paidCur = pay.currency ?? null; }
      }
      // Only a CLEARLY partial refund (same currency, smaller amount) keeps access. Anything unclear is treated as full.
      const amount = Number(d.amount);
      const refundCur = typeof d.currency === "string" ? d.currency.slice(0, 3).toUpperCase() : null;
      const partial = paidTotal !== null && Number.isFinite(amount) && amount > 0 && amount < Number(paidTotal)
        && !!refundCur && !!paidCur && refundCur === paidCur;
      await audit(admin, null, "dodo_refund.succeeded", { id: d.refund_id ?? null, payment_id: paymentId, subscription_id: subId, partial });
      if (!subId) {
        await audit(admin, null, "dodo_refund_unmatched", { payment_id: paymentId });
      } else if (!partial) {
        const at = Date.parse(evt?.timestamp);
        const { data: res, error } = await admin.rpc("billing_revoke_subscription", {
          p_provider: "dodo", p_sub_id: subId, p_reason: "refund",
          p_event_at: new Date(Number.isNaN(at) || at > Date.now() ? Date.now() : at).toISOString(),
        });
        if (error) throw new Error(`revoke failed: ${error.message}`);
        if (res === "unknown_subscription") await audit(admin, null, "dodo_refund_unmatched", { payment_id: paymentId, subscription_id: subId });
        console.log(`dodo-webhook refund -> ${res}`);
      }
      await finish("processed");
      return json({ received: true });
    }

    // ---- other money events we record for the audit trail (ids only, no personal data) ----
    if (type === "payment.failed" || type.startsWith("dispute.")) {
      const d = evt?.data ?? {};
      await audit(admin, null, `dodo_${type}`, {
        id: d.refund_id ?? d.dispute_id ?? d.payment_id ?? null, payment_id: d.payment_id ?? null, subscription_id: d.subscription_id ?? null,
      });
      await finish("processed");
      return json({ received: true });
    }

    await finish("ignored", "unhandled_type");
    return json({ received: true, ignored: "unhandled_type" });
  } catch (err) {
    console.error("dodo-webhook: processing failed:", (err as Error).message);
    await finish("failed", (err as Error).message);
    return json({ error: "processing_failed" }, 500); // non-2xx makes Dodo retry
  }
});
