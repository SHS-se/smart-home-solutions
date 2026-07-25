// Internal heads-up mails to the sales inbox when a customer's subscription
// changes state. These are the counterpart to subscription-emails.ts (which
// writes to the customer); nothing here is ever sent to a customer.
//
// Identity plus the reason something happened, by design: name, email, our
// customer id, a date, an amount and a Stripe reason code. No card brand, last4
// or expiry date is accepted by these types, so a notice — and the Resend log
// behind it — can never become a second place where card data lives. A decline
// code such as expired_card says why a charge failed without describing the
// card; staff who need the card itself look it up in Stripe.
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
  | "signup_abandoned"
  | "dispute_opened";

export interface SubscriptionNoticeCustomer {
  id: string;
  name: string | null;
  email: string | null;
}

export interface SubscriptionNoticeInput {
  event: SubscriptionNoticeEvent;
  customer: SubscriptionNoticeCustomer;
  /** YYYY-MM-DD: access end, next renewal, or the deadline to answer a dispute. */
  date?: string | null;
  /** Stripe decline code (payments) or dispute reason. Never card data. */
  reasonCode?: string | null;
  /** Kronor, for disputes. */
  amount?: number | null;
}

// Stripe decline codes and dispute reasons in Swedish. The two vocabularies
// don't overlap, so one table covers both; anything unmapped falls back to the
// raw code, which is still more useful than nothing.
const REASON_TEXT: Record<string, string> = {
  // Card / charge failures
  expired_card: "Kortet har gått ut",
  card_declined: "Kortet nekades av banken",
  insufficient_funds: "Täckning saknas på kontot",
  incorrect_cvc: "Fel CVC-kod",
  incorrect_number: "Felaktigt kortnummer",
  do_not_honor: "Banken nekade betalningen utan närmare orsak",
  lost_card: "Kortet är anmält förlorat",
  stolen_card: "Kortet är anmält stulet",
  processing_error: "Tekniskt fel hos banken",
  authentication_required: "3D Secure-verifiering krävs",
  // Dispute reasons
  fraudulent: "Kortinnehavaren säger sig inte ha godkänt köpet",
  duplicate: "Kunden anser sig ha blivit debiterad dubbelt",
  product_not_received: "Kunden säger sig inte ha fått tjänsten",
  product_unacceptable: "Kunden är inte nöjd med tjänsten",
  subscription_canceled: "Kunden anser att prenumerationen var uppsagd",
  unrecognized: "Kunden känner inte igen debiteringen",
  credit_not_processed: "Kunden väntar på en återbetalning",
  general: "Ingen orsak angiven",
};

/** "Kortet har gått ut (expired_card)" — text plus the raw code for Stripe lookups. */
export function reasonLabel(code: string | null | undefined): string | null {
  if (!code) return null;
  const text = REASON_TEXT[code];
  return text ? `${text} (${code})` : code;
}

interface NoticeCopy {
  subject: string;
  lead: string;
  /** Rendered with `date` when one is supplied. */
  dated?: (date: string) => string;
}

function copyFor(input: SubscriptionNoticeInput, name: string): NoticeCopy {
  switch (input.event) {
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
        // The expired-card case gets its own subject: it is the one failure that
        // is fixed by a single message to the customer.
        subject: input.reasonCode === "expired_card"
          ? `Förnyelsen misslyckades – kortet har gått ut: ${name}`
          : `Förnyelsen misslyckades: ${name}`,
        lead:
          "Förnyelsen kunde inte dras. Stripe försöker igen under de närmaste dagarna och " +
          "kunden har fått ett mejl om att uppdatera sitt betalkort. Tillgången är kvar tills vidare.",
      };
    case "card_updated":
      return {
        subject: `Betalkort uppdaterat: ${name}`,
        lead: "Kunden har sparat ett nytt betalkort i portalen.",
      };
    case "signup_abandoned":
      return {
        subject: `Påbörjad prenumeration slutfördes aldrig: ${name}`,
        lead:
          "Kunden startade en prenumeration men den första betalningen blev aldrig genomförd, " +
          "så Stripe har stängt den efter 23 timmar. Kunden måste börja om från början – " +
          "ofta har något gått fel i betalningen och det är värt att höra av sig.",
      };
    case "dispute_opened":
      return {
        subject: `Chargeback öppnad: ${name}`,
        lead:
          "Kunden har bestridit en betalning hos sin bank. Skicka in underlag i Stripe före " +
          "sista svarsdag – annars förloras beloppet automatiskt.",
        dated: (date) => `Sista svarsdag: ${date}.`,
      };
  }
}

export function buildSubscriptionStaffNotice(
  input: SubscriptionNoticeInput,
  context: { appEnv: AppEnvironment; appOrigin: string; now: Date },
): { subject: string; text: string } {
  const name = input.customer.name?.trim() || "Namn saknas";
  const copy = copyFor(input, name);
  const stamp = context.now.toLocaleString("sv-SE", { timeZone: "Europe/Stockholm" });
  const reason = reasonLabel(input.reasonCode);

  const text = [
    copy.lead,
    input.date && copy.dated ? copy.dated(input.date) : null,
    "",
    reason ? `Orsak: ${reason}` : null,
    typeof input.amount === "number" ? `Belopp: ${input.amount.toLocaleString("sv-SE")} kr` : null,
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
