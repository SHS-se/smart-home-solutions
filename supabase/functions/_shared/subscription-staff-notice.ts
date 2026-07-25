// Internal heads-up mails to the sales inbox when a customer's subscription
// changes state. These are the counterpart to subscription-emails.ts (which
// writes to the customer); nothing here is ever sent to a customer.
//
// Identity only, by design: name, email and our customer id. No card brand,
// last4 or expiry date is accepted by these types, so a notice — and the Resend
// log behind it — can never become a second place where card data lives. Staff
// who need the card look it up in Stripe.
//
// The message builder is pure so it can be unit-tested; sendSubscriptionStaffNotice
// wraps it and never throws: an internal notice failing must not break a
// completed billing operation.
import { Resend } from "https://esm.sh/resend@2.0.0";
import type { SupabaseClient } from "https://esm.sh/@supabase/supabase-js@2.57.2";
import { type AppEnvironment, getAppEnvironment } from "./app-env.ts";
import { getPrimaryAppOrigin } from "./app-origin.ts";

const FROM = "Smart Home Solutions <faktura@mail.smarthomesolutions.se>";
const DEFAULT_TO = "sales@smarthomesolutions.se";

export type SubscriptionNoticeEvent =
  | "started"
  | "canceled_by_customer"
  | "resumed"
  | "ended_payment_failure"
  | "payment_failed"
  | "card_updated"
  | "card_expires_before_renewal";

export interface SubscriptionNoticeCustomer {
  id: string;
  name: string | null;
  email: string | null;
}

export interface SubscriptionNoticeInput {
  event: SubscriptionNoticeEvent;
  customer: SubscriptionNoticeCustomer;
  /** YYYY-MM-DD: when access ends (cancellation) or the next renewal falls due. */
  date?: string | null;
}

interface NoticeCopy {
  subject: string;
  lead: string;
  /** Rendered with `date` when one is supplied. */
  dated?: (date: string) => string;
}

function copyFor(event: SubscriptionNoticeEvent, name: string): NoticeCopy {
  switch (event) {
    case "started":
      return {
        subject: `Ny prenumeration: ${name}`,
        lead: "En ny prenumeration har startat och den första betalningen är genomförd.",
        dated: (date) => `Nästa förnyelse: ${date}.`,
      };
    case "canceled_by_customer":
      return {
        subject: `Uppsagd prenumeration: ${name}`,
        lead: "Kunden har sagt upp sin prenumeration i portalen.",
        dated: (date) => `Tillgång till och med ${date}, därefter dras inga fler betalningar.`,
      };
    case "resumed":
      return {
        subject: `Återupptagen prenumeration: ${name}`,
        lead: "Kunden har ångrat sin uppsägning – prenumerationen fortsätter som vanligt.",
        dated: (date) => `Nästa förnyelse: ${date}.`,
      };
    case "ended_payment_failure":
      return {
        subject: `Avslutad prenumeration (utebliven betalning): ${name}`,
        lead:
          "Prenumerationen har avslutats eftersom betalningen inte kunde dras. " +
          "Kunden har fått ett mejl om att den är avslutad.",
      };
    case "payment_failed":
      return {
        subject: `Betalning misslyckades: ${name}`,
        lead:
          "Förnyelsen kunde inte dras. Stripe försöker igen under de närmaste dagarna och " +
          "kunden har fått ett mejl om att uppdatera sitt betalkort. Tillgången är kvar tills vidare.",
      };
    case "card_updated":
      return {
        subject: `Betalkort uppdaterat: ${name}`,
        lead: "Kunden har sparat ett nytt betalkort i portalen.",
      };
    case "card_expires_before_renewal":
      // Covers both an already expired card and one that lapses before the
      // renewal is due — from here on the outcome is the same failed charge.
      return {
        subject: `Betalkortet är inte giltigt vid nästa förnyelse: ${name}`,
        lead:
          "Kortet som ligger på filen är inte giltigt när nästa förnyelse ska dras. " +
          "Kunden ser en varning i portalen, men det kan vara värt att följa upp.",
        dated: (date) => `Nästa förnyelse: ${date}.`,
      };
  }
}

export function buildSubscriptionStaffNotice(
  input: SubscriptionNoticeInput,
  context: { appEnv: AppEnvironment; appOrigin: string; now: Date },
): { subject: string; text: string } {
  const name = input.customer.name?.trim() || "Namn saknas";
  const copy = copyFor(input.event, name);
  const dateLine = input.date && copy.dated ? copy.dated(input.date) : null;
  const stamp = context.now.toLocaleString("sv-SE", { timeZone: "Europe/Stockholm" });

  const text = [
    copy.lead,
    dateLine,
    "",
    `Kund: ${name}`,
    `E-post: ${input.customer.email ?? "saknas"}`,
    `Kund-ID: ${input.customer.id}`,
    `${context.appOrigin}/portal/customers/${input.customer.id}`,
    "",
    `Tid: ${stamp}`,
  ]
    .filter((line) => line !== null)
    .join("\n");

  return {
    // Test and live share the sales inbox, so the environment has to be visible
    // in the subject — otherwise a test run looks like a real new customer.
    subject: context.appEnv === "live" ? copy.subject : `[TEST] ${copy.subject}`,
    text,
  };
}

/** Name/email for a notice: both live on the contacts join, not on customers. */
export async function loadNoticeCustomer(
  client: SupabaseClient,
  customerId: string,
): Promise<SubscriptionNoticeCustomer> {
  const { data } = await client
    .from("customers_with_identity")
    .select("contact_email, contact_name")
    .eq("id", customerId)
    .maybeSingle();
  const row = data as { contact_email: string | null; contact_name: string | null } | null;
  return { id: customerId, name: row?.contact_name ?? null, email: row?.contact_email ?? null };
}

export async function sendSubscriptionStaffNotice(input: SubscriptionNoticeInput): Promise<void> {
  try {
    const key = Deno.env.get("RESEND_API_KEY");
    if (!key) throw new Error("RESEND_API_KEY is not set");

    const { subject, text } = buildSubscriptionStaffNotice(input, {
      appEnv: getAppEnvironment(),
      appOrigin: getPrimaryAppOrigin(),
      now: new Date(),
    });

    await new Resend(key).emails.send({
      from: FROM,
      to: [Deno.env.get("STAFF_NOTIFICATION_EMAIL") || DEFAULT_TO],
      subject,
      text,
    });
    console.log(`[STAFF-NOTICE] sent - ${JSON.stringify({ event: input.event })}`);
  } catch (error) {
    // Never propagate: the billing action itself already succeeded.
    console.error(
      `[STAFF-NOTICE] failed - ${JSON.stringify({
        event: input.event,
        message: error instanceof Error ? error.message : String(error),
      })}`,
    );
  }
}
