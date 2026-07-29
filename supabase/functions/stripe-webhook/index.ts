// Stripe webhook → our entitlement + our invoices. Verifies the Stripe
// signature (no JWT — verify_jwt=false), then:
//   invoice.created               → publish buyer name/address to Stripe while
//                                   the invoice is still a draft
//   invoice.paid                  → generate OUR invoice (own numbering) + activate
//   customer.subscription.updated → sync entitlement (incl. cancel-at-period-end)
//   customer.subscription.deleted → revoke entitlement (+ email only when the
//                                   end was caused by failed payment/dispute)
//   invoice.payment_failed        → dunning email on a failed RENEWAL only
//                                   (access kept until period end)
//   charge.dispute.created        → tell staff, nothing customer-facing
// All customer-facing artifacts are ours; Stripe's hosted invoices/receipts are
// never exposed.
//
// Each of these also raises an internal notice to the sales inbox
// (subscription-staff-notice.ts) — identity and reason codes, never card data.
import { serve } from "https://deno.land/std@0.190.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.57.2";
import { getAppEnvironment } from "../_shared/app-env.ts";
import { getStripe } from "../_shared/stripe-client.ts";
import { buildSubscriptionInvoice } from "../_shared/subscription-invoice.ts";
import { subscriptionInvoiceDescription } from "../_shared/subscription-invoice-description.ts";
import {
  endedDueToPaymentFailure,
  entitlementFromSubscription,
} from "../_shared/subscription-entitlement.ts";
import {
  sendPaymentFailedEmail,
  sendSubscriptionCanceledEmail,
} from "../_shared/subscription-emails.ts";
import { sendSubscriptionStaffNotice } from "../_shared/subscription-staff-notice.ts";
import { stripeCustomerIdentity } from "../_shared/stripe-customer-identity.ts";

const logStep = (step: string, details?: unknown) => {
  const detailsStr = details ? ` - ${JSON.stringify(details)}` : "";
  console.log(`[STRIPE-WEBHOOK] ${step}${detailsStr}`);
};

function todayUtc(): string {
  return new Date().toISOString().slice(0, 10);
}

function dateFromUnixSeconds(value: unknown): string | null {
  if (typeof value !== "number" || !Number.isFinite(value)) return null;
  return new Date(value * 1000).toISOString().slice(0, 10);
}

serve(async (req) => {
  const supabaseUrl = Deno.env.get("SUPABASE_URL") ?? "";
  const serviceClient = createClient(supabaseUrl, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "", {
    auth: { persistSession: false },
  });

  // Resolve our customer (id + contact email/name) from a Stripe customer id.
  // Name/email live on the contacts join, so read them from customers_with_identity.
  const ourCustomer = async (stripeCustomerId: string | null) => {
    if (!stripeCustomerId) return null;
    const { data: row } = await serviceClient
      .from("customers")
      .select("id")
      .eq("stripe_customer_id", stripeCustomerId)
      .maybeSingle();
    if (!row) return null;
    const id = (row as { id: string }).id;
    const { data: identity } = await serviceClient
      .from("customers_with_identity")
      .select("contact_email, contact_name")
      .eq("id", id)
      .maybeSingle();
    return {
      id,
      email: (identity as { contact_email: string | null } | null)?.contact_email ?? null,
      name: (identity as { contact_name: string | null } | null)?.contact_name ?? null,
    };
  };

  // Why a charge failed, from the invoice's PaymentIntent: a decline code such
  // as expired_card, never anything describing the card. Advisory — a lookup
  // failure just means the notice goes out without a reason.
  const declineCodeForInvoice = async (invoice: { payment_intent?: unknown }) => {
    const paymentIntentId = invoice.payment_intent;
    if (typeof paymentIntentId !== "string") return null;
    try {
      const intent = await getStripe().paymentIntents.retrieve(paymentIntentId);
      const error = intent.last_payment_error;
      return error?.decline_code ?? error?.code ?? null;
    } catch (error) {
      logStep("decline code lookup failed", {
        message: error instanceof Error ? error.message : String(error),
      });
      return null;
    }
  };

  try {
    const appEnv = getAppEnvironment();
    const signature = req.headers.get("stripe-signature");
    const webhookSecret = Deno.env.get("STRIPE_WEBHOOK_SECRET");
    if (!signature || !webhookSecret) throw new Error("Missing webhook signature/secret");

    const body = await req.text();
    const stripe = getStripe();
    const event = await stripe.webhooks.constructEventAsync(body, signature, webhookSecret);
    logStep("Event", { type: event.type, id: event.id });

    switch (event.type) {
      case "invoice.paid": {
        // deno-lint-ignore no-explicit-any
        const invoice = event.data.object as any;
        const customer = await ourCustomer(invoice.customer);
        if (!customer) {
          logStep("No matching customer for invoice.paid", { stripeCustomer: invoice.customer });
          break;
        }
        const grossAmount = (invoice.amount_paid ?? 0) / 100; // öre → kr
        const periodEnd: number | undefined = invoice.lines?.data?.[0]?.period?.end;
        const renewalDate = periodEnd ? dateFromUnixSeconds(periodEnd) : null;
        const result = await buildSubscriptionInvoice(serviceClient, {
          customerId: customer.id,
          stripeInvoiceId: invoice.id,
          grossAmount,
          description: subscriptionInvoiceDescription(invoice),
          paymentDate: dateFromUnixSeconds(invoice.status_transitions?.paid_at ?? invoice.created) ?? todayUtc(),
          appEnv,
        });
        await serviceClient
          .from("customers")
          .update({
            subscription_active: true,
            subscription_expires_at: periodEnd ? new Date(periodEnd * 1000).toISOString() : null,
            subscription_cancel_at_period_end: false,
          })
          .eq("id", customer.id);
        logStep("invoice.paid handled", { invoiceNumber: result.invoiceNumber, created: result.created });

        // The first paid invoice of a subscription is the moment it really
        // started — the subscription row exists before that, unpaid.
        if (invoice.billing_reason === "subscription_create") {
          await sendSubscriptionStaffNotice({
            event: "started",
            customer: { id: customer.id, name: customer.name, email: customer.email },
            date: renewalDate,
          });
        }
        break;
      }
      case "customer.subscription.updated":
      case "customer.subscription.deleted": {
        // deno-lint-ignore no-explicit-any
        const sub = event.data.object as any;
        const customer = await ourCustomer(sub.customer);
        if (!customer) {
          logStep("No matching customer for subscription event", { stripeCustomer: sub.customer });
          break;
        }
        // The signup's first payment was never completed, so Stripe closed the
        // subscription after 23h. It is terminal — detach it so the portal
        // offers a fresh subscribe instead of trying to resume a dead one.
        //
        // Stripe's docs don't pin down whether this arrives as .updated or
        // .deleted, so both are handled; the conditional update is what makes
        // that safe, since only the first event to arrive still matches the row
        // and gets to send the notice.
        if (sub.status === "incomplete_expired") {
          const { data: detached } = await serviceClient
            .from("customers")
            .update({
              subscription_active: false,
              subscription_cancel_at_period_end: false,
              stripe_subscription_id: null,
            })
            .eq("id", customer.id)
            .eq("stripe_subscription_id", sub.id)
            .select("id")
            .maybeSingle();

          if (detached) {
            await sendSubscriptionStaffNotice({
              event: "signup_abandoned",
              customer: { id: customer.id, name: customer.name, email: customer.email },
            });
            logStep("signup abandoned", { subscriptionId: sub.id });
          }
          break;
        }

        const entitlement = entitlementFromSubscription(sub);
        await serviceClient
          .from("customers")
          .update({ ...entitlement, stripe_subscription_id: sub.id })
          .eq("id", customer.id);
        logStep("subscription synced", { active: entitlement.subscription_active });
        // Email only when the subscription ended because payment collection
        // failed. Voluntary cancellations were confirmed at cancel time
        // (cancel-subscription), so their period-end deletion stays silent.
        if (event.type === "customer.subscription.deleted") {
          if (endedDueToPaymentFailure(sub)) {
            if (customer.email) {
              await sendSubscriptionCanceledEmail(customer.email, customer.name);
              logStep("canceled email sent (payment failure)");
            }
            // Involuntary churn: the voluntary case was already reported to the
            // sales inbox by cancel-subscription, so only this one is notified.
            await sendSubscriptionStaffNotice({
              event: "ended_payment_failure",
              customer: { id: customer.id, name: customer.name, email: customer.email },
            });
          } else {
            logStep("subscription ended, no email", {
              reason: sub.cancellation_details?.reason ?? null,
            });
          }
        }
        break;
      }
      case "invoice.payment_failed": {
        // deno-lint-ignore no-explicit-any
        const invoice = event.data.object as any;
        const customer = await ourCustomer(invoice.customer);
        // Renewals only. A card declined while the customer is still on the
        // payment form needs no mail from us — they can already see the decline
        // and normally retry on the spot; "update your card or the subscription
        // ends" would be nonsense about a subscription that never started. If
        // they give up, the abandoned-signup notice covers it 23 hours later.
        const isSignupPayment = invoice.billing_reason === "subscription_create";
        // Then only on the FIRST failure; Stripe keeps retrying through the grace
        // period, and access continues until the subscription is finally cancelled.
        // <= 1 because a failure that never reached the charge (e.g. the issuer
        // demanded authentication, July 2026 incident) reports attempt_count 0.
        if (customer && !isSignupPayment && (invoice.attempt_count ?? 1) <= 1) {
          if (customer.email) {
            await sendPaymentFailedEmail(customer.email, customer.name);
            logStep("payment-failed email sent");
          }
          await sendSubscriptionStaffNotice({
            event: "payment_failed",
            customer: { id: customer.id, name: customer.name, email: customer.email },
            reasonCode: await declineCodeForInvoice(invoice),
          });
        } else {
          logStep("invoice.payment_failed (no email)", {
            attempt: invoice.attempt_count,
            billingReason: invoice.billing_reason ?? null,
          });
        }
        break;
      }
      case "invoice.created": {
        // A renewal invoice starts as a draft and only copies the customer's
        // name and address when Stripe finalizes it (about an hour later), so
        // this is the window in which to make sure they are current. Also what
        // backfills customers created before we published any of this — no
        // re-subscribe needed, their next renewal carries the name.
        // deno-lint-ignore no-explicit-any
        const invoice = event.data.object as any;
        const customer = await ourCustomer(invoice.customer);
        if (!customer) {
          logStep("No matching customer for invoice.created", { stripeCustomer: invoice.customer });
          break;
        }
        const { data: address } = await serviceClient
          .from("customers")
          .select(
            "billing_same_as_site, site_street, site_postcode, site_city, billing_street, billing_postcode, billing_city",
          )
          .eq("id", customer.id)
          .maybeSingle();
        const buyer = stripeCustomerIdentity(customer.name, address);
        if (!buyer) {
          logStep("invoice.created: incomplete buyer details, nothing published");
          break;
        }
        try {
          await stripe.customers.update(invoice.customer, buyer);
          logStep("Stripe customer details refreshed before finalization");
        } catch (error) {
          // Advisory: the invoice still finalizes, just without the update.
          logStep("Stripe customer refresh failed", {
            message: error instanceof Error ? error.message : String(error),
          });
        }
        break;
      }
      case "charge.dispute.created": {
        // deno-lint-ignore no-explicit-any
        const dispute = event.data.object as any;
        // The dispute carries no customer, so resolve it through the charge.
        const charge = typeof dispute.charge === "string"
          ? await stripe.charges.retrieve(dispute.charge)
          : null;
        const customer = await ourCustomer(
          typeof charge?.customer === "string" ? charge.customer : null,
        );
        if (!customer) {
          logStep("No matching customer for dispute", { charge: dispute.charge });
          break;
        }
        await sendSubscriptionStaffNotice({
          event: "dispute_opened",
          customer: { id: customer.id, name: customer.name, email: customer.email },
          date: dateFromUnixSeconds(dispute.evidence_details?.due_by),
          reasonCode: dispute.reason ?? null,
          amount: (dispute.amount ?? 0) / 100, // öre → kr
        });
        logStep("dispute notice sent", { disputeId: dispute.id });
        break;
      }
      default:
        logStep("Ignored event", { type: event.type });
    }

    return new Response(JSON.stringify({ received: true }), {
      headers: { "Content-Type": "application/json" },
      status: 200,
    });
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    logStep("ERROR", { message: msg });
    // 400 so Stripe retries (signature/transient failures).
    return new Response(JSON.stringify({ error: msg }), {
      headers: { "Content-Type": "application/json" },
      status: 400,
    });
  }
});
