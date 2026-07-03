// Stripe webhook → our entitlement + our invoices. Verifies the Stripe
// signature (no JWT — verify_jwt=false), then:
//   invoice.paid                  → generate OUR invoice (own numbering) + activate
//   customer.subscription.updated → sync entitlement (incl. cancel-at-period-end)
//   customer.subscription.deleted → revoke entitlement
//   invoice.payment_failed        → log (access kept until period end)
// All customer-facing artifacts are ours; Stripe's hosted invoices/receipts are
// never exposed.
import { serve } from "https://deno.land/std@0.190.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.57.2";
import { getAppEnvironment } from "../_shared/app-env.ts";
import { getStripe } from "../_shared/stripe-client.ts";
import { buildSubscriptionInvoice } from "../_shared/subscription-invoice.ts";
import { subscriptionInvoiceDescription } from "../_shared/subscription-invoice-description.ts";
import { entitlementFromSubscription } from "../_shared/subscription-entitlement.ts";
import {
  sendPaymentFailedEmail,
  sendSubscriptionCanceledEmail,
} from "../_shared/subscription-emails.ts";

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
        const entitlement = entitlementFromSubscription(sub);
        await serviceClient
          .from("customers")
          .update({ ...entitlement, stripe_subscription_id: sub.id })
          .eq("id", customer.id);
        logStep("subscription synced", { active: entitlement.subscription_active });
        // Retries exhausted → subscription cancelled: tell the customer (our email).
        if (event.type === "customer.subscription.deleted" && customer.email) {
          await sendSubscriptionCanceledEmail(customer.email, customer.name);
          logStep("canceled email sent");
        }
        break;
      }
      case "invoice.payment_failed": {
        // deno-lint-ignore no-explicit-any
        const invoice = event.data.object as any;
        const customer = await ourCustomer(invoice.customer);
        // Email only on the FIRST failure; Stripe keeps retrying through the grace
        // period, and access continues until the subscription is finally cancelled.
        if (customer?.email && (invoice.attempt_count ?? 1) === 1) {
          await sendPaymentFailedEmail(customer.email, customer.name);
          logStep("payment-failed email sent");
        } else {
          logStep("invoice.payment_failed (no email)", { attempt: invoice.attempt_count });
        }
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
