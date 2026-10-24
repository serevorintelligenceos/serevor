// Pure email builder (no network, no Deno globals) so it can be unit-tested.

// Keep in sync with PRICES in src/lib/billing/plans.js (shown in USD; the customer is charged in their local currency).
export const PRICE = { month: "$13.99", year: "$139.99" } as const;

const esc = (s: string) =>
  s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#39;");

// Always UTC with the zone shown, so nobody in another timezone is surprised by the date.
export function formatTrialEnd(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  const date = d.toLocaleDateString("en-GB", { timeZone: "UTC", day: "numeric", month: "long", year: "numeric" });
  const time = d.toLocaleTimeString("en-GB", { timeZone: "UTC", hour: "2-digit", minute: "2-digit", hour12: false });
  return `${date}, ${time} UTC`;
}

export interface TrialEmailInput {
  trialEndsAt: string;
  interval: string | null;
  siteUrl: string;
  supportEmail: string;
}

export function buildTrialEndingEmail(i: TrialEmailInput): { subject: string; html: string; text: string } | null {
  const when = formatTrialEnd(i.trialEndsAt);
  if (!when) return null; // never send an email with a broken date

  const price = i.interval === "month" || i.interval === "year" ? `${PRICE[i.interval]} a ${i.interval}` : "the price shown when you signed up";
  const link = `${i.siteUrl.replace(/\/+$/, "")}/settings/account`;
  const subject = "Your Serevor Pro trial ends in 2 days";

  const text = [
    "Hi,",
    "",
    `Your free trial of Serevor Pro ends on ${when}.`,
    "",
    `If you do nothing, your plan starts then at ${price}, charged in your local currency.`,
    "",
    `Not for you? Cancel before ${when} and you will not be charged. You keep Pro until the trial ends.`,
    `Open Serevor, then go to Settings, Account and tap Manage: ${link}`,
    "",
    `Questions? Just reply to this email or write to ${i.supportEmail}.`,
    "",
    "The Serevor team",
    "",
    "You are receiving this because you started a free trial of Serevor Pro.",
  ].join("\n");

  const html = `<!doctype html>
<html><body style="margin:0;background:#f4f5f7;font-family:-apple-system,'Segoe UI',Roboto,Arial,sans-serif;color:#1a1d21">
  <div style="max-width:520px;margin:0 auto;padding:24px 16px">
    <div style="background:#ffffff;border:1px solid #e5e7eb;border-radius:12px;padding:28px">
      <p style="margin:0 0 18px;font-size:13px;letter-spacing:.02em;color:#6b7280">Serevor</p>
      <h1 style="margin:0 0 14px;font-size:21px;line-height:1.3">Your Pro trial ends in 2 days</h1>
      <p style="margin:0 0 14px;font-size:15px;line-height:1.6">Your free trial of Serevor Pro ends on <strong>${esc(when)}</strong>.</p>
      <p style="margin:0 0 14px;font-size:15px;line-height:1.6">If you do nothing, your plan starts then at <strong>${esc(price)}</strong>, charged in your local currency.</p>
      <p style="margin:0 0 22px;font-size:15px;line-height:1.6">Not for you? Cancel before then and you will not be charged. You keep Pro until the trial ends.</p>
      <p style="margin:0 0 22px"><a href="${esc(link)}" style="display:inline-block;background:#00d4aa;color:#06231c;padding:12px 20px;border-radius:8px;text-decoration:none;font-weight:600;font-size:15px">Manage my plan</a></p>
      <p style="margin:0 0 6px;font-size:13px;line-height:1.6;color:#4b5563">In Serevor: Settings, then Account, then Manage.</p>
      <p style="margin:0;font-size:13px;line-height:1.6;color:#4b5563">Questions? Reply to this email or write to ${esc(i.supportEmail)}.</p>
    </div>
    <p style="margin:14px 4px 0;font-size:12px;line-height:1.5;color:#9ca3af">You are receiving this because you started a free trial of Serevor Pro.</p>
  </div>
</body></html>`;

  return { subject, html, text };
}
