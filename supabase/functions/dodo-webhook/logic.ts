// Pure helpers for the Dodo webhook. No Deno or Node globals except WebCrypto, so they can be unit-tested.

export const TOLERANCE_SECONDS = 300; // reject deliveries older/newer than 5 minutes (replay protection)

const b64ToBytes = (b64: string): Uint8Array => {
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
};
const bytesToB64 = (buf: ArrayBuffer): string => {
  let s = "";
  for (const x of new Uint8Array(buf)) s += String.fromCharCode(x);
  return btoa(s);
};
function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

// Standard Webhooks verification: HMAC-SHA256 over "{id}.{timestamp}.{rawBody}", base64, "v1,<sig>" (space-separated list).
export async function verifyWebhook(o: {
  secret: string; id: string | null; timestamp: string | null; signature: string | null; body: string; nowMs?: number;
}): Promise<boolean> {
  const { secret, id, timestamp, signature, body } = o;
  if (!secret || !id || !timestamp || !signature) return false;
  const ts = Number(timestamp);
  if (!Number.isFinite(ts)) return false;
  const nowSec = Math.floor((o.nowMs ?? Date.now()) / 1000);
  if (Math.abs(nowSec - ts) > TOLERANCE_SECONDS) return false;
  let keyBytes: Uint8Array;
  try { keyBytes = b64ToBytes(secret.startsWith("whsec_") ? secret.slice(6) : secret); } catch { return false; }
  const key = await crypto.subtle.importKey("raw", keyBytes, { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const mac = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(`${id}.${timestamp}.${body}`));
  const expected = bytesToB64(mac);
  let ok = false;
  for (const part of signature.split(" ")) {
    const [ver, sig] = part.split(",");
    if (ver === "v1" && sig && timingSafeEqual(sig, expected)) ok = true; // no early exit
  }
  return ok;
}

export type OurStatus = "incomplete" | "active" | "past_due" | "cancelled" | "expired";

// Dodo status -> ours. Unknown values return null: we ignore what we do not understand, never guess.
export function mapStatus(s: unknown): OurStatus | null {
  switch (s) {
    case "active": return "active";
    case "on_hold": return "past_due";
    case "cancelled": return "cancelled";
    case "expired": return "expired";
    case "pending": return "incomplete";
    case "failed": return "incomplete";
    default: return null;
  }
}

export interface Normalized {
  subscriptionId: string;
  customerId: string | null;
  status: OurStatus;
  interval: "month" | "year";
  periodEnd: string | null;
  cancelAtPeriodEnd: boolean;
  cancelledAt: string | null;
  currency: string | null;
  eventAt: string;
  checkoutSessionId: string | null;
  productId: string;
  trialDays: number | null;
}
export type NormalizeResult = { ok: true; value: Normalized } | { ok: false; reason: string };

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const validIso = (v: unknown): string | null => {
  if (typeof v !== "string") return null;
  const t = Date.parse(v);
  return Number.isNaN(t) ? null : new Date(t).toISOString();
};

// Every subscription event carries the latest full state, so ONE reducer handles them all
// (the status field is the truth, not the event name). Ordering is protected by eventAt.
// deno-lint-ignore no-explicit-any
export function normalizeSubscriptionEvent(evt: any, products: { monthly?: string; annual?: string }, nowMs = Date.now(), headerTs?: string | null): NormalizeResult {
  if (!evt || typeof evt.type !== "string" || !evt.type.startsWith("subscription.")) return { ok: false, reason: "not_subscription_event" };
  const d = evt.data;
  if (!d || typeof d !== "object") return { ok: false, reason: "missing_data" };
  if (typeof d.subscription_id !== "string" || !d.subscription_id) return { ok: false, reason: "missing_subscription_id" };

  const status = mapStatus(d.status);
  if (!status) return { ok: false, reason: "unknown_status" };

  if (!products.monthly && !products.annual) return { ok: false, reason: "products_not_configured" };
  const productId = typeof d.product_id === "string" ? d.product_id : "";
  const interval = productId && productId === products.monthly ? "month" : productId && productId === products.annual ? "year" : null;
  if (!interval) return { ok: false, reason: "foreign_product" }; // only OUR two Pro products can ever grant access

  let eventAt = validIso(evt.timestamp);
  if (!eventAt && headerTs && Number.isFinite(Number(headerTs))) eventAt = new Date(Number(headerTs) * 1000).toISOString();
  if (!eventAt) return { ok: false, reason: "bad_timestamp" };
  if (Date.parse(eventAt) > nowMs + 10 * 60 * 1000) eventAt = new Date(nowMs).toISOString(); // a future stamp can never freeze later events

  const periodEnd = validIso(d.next_billing_date) ?? validIso(d.expires_at);
  if (status === "active" && !periodEnd) return { ok: false, reason: "missing_period_end" }; // retry rather than lock out a paying user

  const sessionId = typeof d.metadata?.checkout_session_id === "string" && UUID.test(d.metadata.checkout_session_id)
    ? d.metadata.checkout_session_id.toLowerCase() : null;
  const cur = typeof d.currency === "string" && /^[A-Za-z]{3}$/.test(d.currency) ? d.currency.toUpperCase() : null;

  return {
    ok: true,
    value: {
      subscriptionId: d.subscription_id,
      customerId: typeof d.customer?.customer_id === "string" ? d.customer.customer_id : null,
      status, interval, periodEnd,
      cancelAtPeriodEnd: d.cancel_at_next_billing_date === true,
      cancelledAt: validIso(d.cancelled_at),
      currency: cur, eventAt, checkoutSessionId: sessionId, productId,
      trialDays: Number.isInteger(d.trial_period_days) && d.trial_period_days > 0 && d.trial_period_days <= 365 ? d.trial_period_days : null,
    },
  };
}
