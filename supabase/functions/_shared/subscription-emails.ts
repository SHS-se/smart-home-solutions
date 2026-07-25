// White-label dunning emails sent in place of Stripe's. Stripe runs the billing
// state machine (retries / grace period); we mirror the customer-facing emails
// using Resend so no Stripe branding reaches the customer.
import { Resend } from "https://esm.sh/resend@2.0.0";
import { getPrimaryAppOrigin } from "./app-origin.ts";

const FROM = "Smart Home Solutions <faktura@mail.smarthomesolutions.se>";

function resend(): Resend {
  const key = Deno.env.get("RESEND_API_KEY");
  if (!key) throw new Error("RESEND_API_KEY is not set");
  return new Resend(key);
}

function billingUrl(): string {
  return `${getPrimaryAppOrigin()}/portal/billing`;
}

/** First failed renewal: prompt the customer to update their card during the
 *  grace period before the subscription is cancelled. Renewals only — a decline
 *  on the signup payment is visible to the customer on the form itself, and
 *  stripe-webhook deliberately stays quiet about it. */
export async function sendPaymentFailedEmail(to: string, name: string | null): Promise<void> {
  const hej = name ? `Hej ${name},` : "Hej,";
  const url = billingUrl();
  const text =
    `${hej}\n\n` +
    `Vi kunde inte dra betalningen för din prenumeration på Smart Home Solutions.\n\n` +
    `Vi försöker igen automatiskt under de närmaste dagarna. För att undvika att ` +
    `prenumerationen avslutas kan du uppdatera ditt betalkort här:\n${url}\n\n` +
    `Hör av dig om du har frågor.\nSmart Home Solutions`;
  await resend().emails.send({
    from: FROM,
    to: [to],
    subject: "Betalningen för din prenumeration misslyckades",
    text,
  });
}

/** Customer-requested cancellation confirmed: access continues until the paid
 *  period ends, then no more charges. This is the only email for a voluntary
 *  cancellation — nothing further is sent when the period actually runs out. */
export async function sendCancelConfirmationEmail(
  to: string,
  name: string | null,
  accessUntil: string | null, // YYYY-MM-DD, from the subscription's current_period_end
): Promise<void> {
  const hej = name ? `Hej ${name},` : "Hej,";
  const url = billingUrl();
  const access = accessUntil
    ? `Du har tillgång till tjänsten till och med ${accessUntil}. Därefter dras inga fler betalningar.`
    : `Du har tillgång till tjänsten perioden ut. Därefter dras inga fler betalningar.`;
  const text =
    `${hej}\n\n` +
    `Vi bekräftar att din prenumeration på Smart Home Solutions är uppsagd.\n\n` +
    `${access}\n\n` +
    `Ångrar du dig? Starta prenumerationen igen när som helst här:\n${url}\n\n` +
    `Smart Home Solutions`;
  await resend().emails.send({
    from: FROM,
    to: [to],
    subject: "Din prenumeration är uppsagd",
    text,
  });
}

/** Retries exhausted and the subscription was cancelled. */
export async function sendSubscriptionCanceledEmail(to: string, name: string | null): Promise<void> {
  const hej = name ? `Hej ${name},` : "Hej,";
  const url = billingUrl();
  const text =
    `${hej}\n\n` +
    `Din prenumeration på Smart Home Solutions har avslutats eftersom vi inte kunde ` +
    `dra betalningen.\n\n` +
    `Vill du fortsätta? Starta en ny prenumeration när som helst här:\n${url}\n\n` +
    `Smart Home Solutions`;
  await resend().emails.send({
    from: FROM,
    to: [to],
    subject: "Din prenumeration har avslutats",
    text,
  });
}
