// Generates one of OUR invoices (own sequential numbering, downloadable PDF) for
// a paid Stripe subscription invoice. Mirrors create-draft-invoice +
// finalize-new-invoice + record-invoice-payment, but runs with the service
// client (no staff auth) so the webhook can call it. Idempotent on
// invoices.stripe_invoice_id. The pure bits are unit-tested.
import type { SupabaseClient } from "https://esm.sh/@supabase/supabase-js@2.57.2";

type AppEnv = "test" | "live";

export interface SubscriptionInvoiceAmounts {
  net: number; // ex-VAT unit price (what invoice_line_items stores)
  vat: number;
  gross: number; // VAT-inclusive total Stripe charged
}

/** Splits a VAT-inclusive gross amount into ex-VAT net + VAT at the given rate. */
export function splitVatInclusive(gross: number, vatRatePct: number): SubscriptionInvoiceAmounts {
  const round2 = (n: number) => Math.round(n * 100) / 100;
  const g = round2(gross);
  const net = round2(g / (1 + vatRatePct / 100));
  return { net, vat: round2(g - net), gross: g };
}

export interface BuildSubscriptionInvoiceArgs {
  customerId: string;
  stripeInvoiceId: string;
  grossAmount: number; // VAT-inclusive amount Stripe charged, in SEK
  description: string;
  paymentDate: string; // YYYY-MM-DD
  appEnv: AppEnv;
  vatRatePct?: number; // default 25
}

export interface BuildSubscriptionInvoiceResult {
  invoiceId: string;
  invoiceNumber: string | null;
  created: boolean; // false when an invoice for this Stripe invoice already existed
}

/**
 * Idempotently creates + finalizes + marks-paid an SHS invoice for a paid Stripe
 * subscription invoice. Re-deliveries of the same webhook are no-ops because the
 * existing invoice is found by its stripe_invoice_id.
 */
export async function buildSubscriptionInvoice(
  client: SupabaseClient,
  args: BuildSubscriptionInvoiceArgs,
): Promise<BuildSubscriptionInvoiceResult> {
  const vatRatePct = args.vatRatePct ?? 25;

  // 1. Idempotency — already generated for this Stripe invoice?
  const { data: existing } = await client
    .from("invoices")
    .select("id, invoice_number")
    .eq("stripe_invoice_id", args.stripeInvoiceId)
    .maybeSingle();
  if (existing) {
    return {
      invoiceId: (existing as { id: string }).id,
      invoiceNumber: (existing as { invoice_number: string | null }).invoice_number ?? null,
      created: false,
    };
  }

  const { net, gross } = splitVatInclusive(args.grossAmount, vatRatePct);

  // 2. Draft invoice carrying the Stripe linkage.
  const { data: invoice, error: invErr } = await client
    .from("invoices")
    .insert({
      customer_id: args.customerId,
      status: "draft",
      currency: "SEK",
      created_by: null,
      is_test: args.appEnv === "test",
      stripe_invoice_id: args.stripeInvoiceId,
      stripe_status: "paid",
    })
    .select("id")
    .single();
  if (invErr || !invoice) {
    throw new Error(`Failed to create subscription invoice: ${invErr?.message ?? "unknown"}`);
  }
  const invoiceId = (invoice as { id: string }).id;

  // 3. Single service line item (ex-VAT unit price + separate tax_rate).
  const { error: liErr } = await client.from("invoice_line_items").insert({
    invoice_id: invoiceId,
    line_type: "travel_other",
    description: args.description,
    quantity: 1,
    unit_price: net,
    tax_rate: vatRatePct,
    sort_order: 0,
  });
  if (liErr) throw new Error(`Failed to create subscription invoice line: ${liErr.message}`);

  // 4. Finalize: allocates the invoice number + freezes seller/buyer snapshots.
  const { data: finalized, error: finErr } = await client.rpc("finalize_local_invoice", {
    p_invoice_id: invoiceId,
    p_app_env: args.appEnv,
    p_created_by: null,
  });
  if (finErr) throw new Error(`Failed to finalize subscription invoice: ${finErr.message}`);
  const invoiceNumber =
    (finalized as { invoice_number?: string } | null)?.invoice_number ?? null;

  // 5. Record the Stripe payment and mark the invoice paid.
  const { error: payErr } = await client.from("invoice_payments").insert({
    invoice_id: invoiceId,
    payment_date: args.paymentDate,
    amount: gross,
    method: "stripe",
    reference: args.stripeInvoiceId,
    created_by: null,
  });
  if (payErr) throw new Error(`Failed to record subscription payment: ${payErr.message}`);

  const { error: updErr } = await client
    .from("invoices")
    .update({
      status: "paid",
      paid_at: new Date(`${args.paymentDate}T12:00:00Z`).toISOString(),
      updated_at: new Date().toISOString(),
    })
    .eq("id", invoiceId);
  if (updErr) throw new Error(`Failed to mark subscription invoice paid: ${updErr.message}`);

  return { invoiceId, invoiceNumber, created: true };
}
