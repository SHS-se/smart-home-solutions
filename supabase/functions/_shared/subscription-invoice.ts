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

interface ExistingInvoice {
  id: string;
  invoice_number: string | null;
  status: string | null;
  voided_at: string | null;
}

interface ExistingLineItem {
  id: string;
  line_type: string | null;
}

interface ExistingPayment {
  id: string;
  amount: number | string;
  payment_date: string;
}

async function ensureSubscriptionLine(
  client: SupabaseClient,
  invoiceId: string,
  args: { description: string; unitPrice: number; vatRatePct: number },
): Promise<void> {
  const { data: lines, error } = await client
    .from("invoice_line_items")
    .select("id, line_type")
    .eq("invoice_id", invoiceId);
  if (error) throw new Error(`Failed to inspect subscription invoice lines: ${error.message}`);

  const existingLines = (lines || []) as ExistingLineItem[];
  if (existingLines.length === 0) {
    const { error: insertError } = await client.from("invoice_line_items").insert({
      invoice_id: invoiceId,
      line_type: "travel_other",
      description: args.description,
      quantity: 1,
      unit_price: args.unitPrice,
      tax_rate: args.vatRatePct,
      sort_order: 0,
    });
    if (insertError) throw new Error(`Failed to create subscription invoice line: ${insertError.message}`);
    return;
  }

  if (existingLines.length > 1) {
    throw new Error(`Subscription invoice ${invoiceId} has multiple line items; refusing to guess which one to repair`);
  }

  const [line] = existingLines;
  if (line.line_type !== "travel_other") {
    throw new Error(`Subscription invoice ${invoiceId} has unexpected line type ${line.line_type}`);
  }

  const { error: updateError } = await client
    .from("invoice_line_items")
    .update({
      description: args.description,
      quantity: 1,
      unit_price: args.unitPrice,
      tax_rate: args.vatRatePct,
      sort_order: 0,
    })
    .eq("id", line.id);
  if (updateError) throw new Error(`Failed to repair subscription invoice line: ${updateError.message}`);
}

async function finalizeIfNeeded(
  client: SupabaseClient,
  invoice: ExistingInvoice,
  args: { appEnv: AppEnv },
): Promise<string | null> {
  if (invoice.invoice_number && invoice.status !== "draft") {
    return invoice.invoice_number;
  }

  const { data: finalized, error } = await client.rpc("finalize_local_invoice", {
    p_invoice_id: invoice.id,
    p_app_env: args.appEnv,
    p_created_by: null,
  });
  if (error) throw new Error(`Failed to finalize subscription invoice: ${error.message}`);

  return (finalized as { invoice_number?: string } | null)?.invoice_number ?? invoice.invoice_number;
}

async function ensureStripePayment(
  client: SupabaseClient,
  invoiceId: string,
  args: { paymentDate: string; amount: number; stripeInvoiceId: string },
): Promise<void> {
  const { data: existing, error } = await client
    .from("invoice_payments")
    .select("id, amount, payment_date")
    .eq("invoice_id", invoiceId)
    .eq("method", "stripe")
    .eq("reference", args.stripeInvoiceId)
    .maybeSingle();
  if (error) throw new Error(`Failed to inspect subscription payment: ${error.message}`);

  if (!existing) {
    const { error: insertError } = await client.from("invoice_payments").insert({
      invoice_id: invoiceId,
      payment_date: args.paymentDate,
      amount: args.amount,
      method: "stripe",
      reference: args.stripeInvoiceId,
      created_by: null,
    });
    if (insertError) throw new Error(`Failed to record subscription payment: ${insertError.message}`);
    return;
  }

  const payment = existing as ExistingPayment;
  if (Number(payment.amount) === args.amount && payment.payment_date === args.paymentDate) {
    return;
  }

  const { error: updateError } = await client
    .from("invoice_payments")
    .update({
      payment_date: args.paymentDate,
      amount: args.amount,
    })
    .eq("id", payment.id);
  if (updateError) throw new Error(`Failed to repair subscription payment: ${updateError.message}`);
}

async function markInvoicePaid(
  client: SupabaseClient,
  invoiceId: string,
  paymentDate: string,
): Promise<void> {
  const { error } = await client
    .from("invoices")
    .update({
      status: "paid",
      due_date: paymentDate,
      paid_at: new Date(`${paymentDate}T12:00:00Z`).toISOString(),
      updated_at: new Date().toISOString(),
    })
    .eq("id", invoiceId);
  if (error) throw new Error(`Failed to mark subscription invoice paid: ${error.message}`);
}

/**
 * Idempotently creates + finalizes + marks-paid an SHS invoice for a paid Stripe
 * subscription invoice. Re-deliveries of the same webhook complete any partial
 * local invoice for the same Stripe invoice instead of leaving it open/stale.
 */
export async function buildSubscriptionInvoice(
  client: SupabaseClient,
  args: BuildSubscriptionInvoiceArgs,
): Promise<BuildSubscriptionInvoiceResult> {
  const vatRatePct = args.vatRatePct ?? 25;
  const { net, gross } = splitVatInclusive(args.grossAmount, vatRatePct);

  // 1. Idempotency — already generated for this Stripe invoice?
  const { data: existing } = await client
    .from("invoices")
    .select("id, invoice_number, status, voided_at")
    .eq("stripe_invoice_id", args.stripeInvoiceId)
    .maybeSingle();
  if (existing) {
    const invoice = existing as ExistingInvoice;
    if (invoice.status === "void" || invoice.voided_at) {
      throw new Error(`Subscription invoice ${invoice.id} is voided and cannot be repaired`);
    }

    await ensureSubscriptionLine(client, invoice.id, {
      description: args.description,
      unitPrice: net,
      vatRatePct,
    });
    const invoiceNumber = await finalizeIfNeeded(client, invoice, { appEnv: args.appEnv });
    await ensureStripePayment(client, invoice.id, {
      paymentDate: args.paymentDate,
      amount: gross,
      stripeInvoiceId: args.stripeInvoiceId,
    });
    await markInvoicePaid(client, invoice.id, args.paymentDate);

    return {
      invoiceId: invoice.id,
      invoiceNumber,
      created: false,
    };
  }

  // 2. Draft invoice carrying the Stripe linkage.
  const { data: invoice, error: invErr } = await client
    .from("invoices")
    .insert({
      customer_id: args.customerId,
      status: "draft",
      currency: "SEK",
      due_date: args.paymentDate,
      created_by: null,
      is_test: args.appEnv === "test",
      stripe_invoice_id: args.stripeInvoiceId,
    })
    .select("id")
    .single();
  if (invErr || !invoice) {
    throw new Error(`Failed to create subscription invoice: ${invErr?.message ?? "unknown"}`);
  }
  const invoiceId = (invoice as { id: string }).id;

  // 3. Single service line item (ex-VAT unit price + separate tax_rate).
  await ensureSubscriptionLine(client, invoiceId, {
    description: args.description,
    unitPrice: net,
    vatRatePct,
  });

  // 4. Finalize: allocates the invoice number + freezes seller/buyer snapshots.
  const invoiceNumber = await finalizeIfNeeded(client, {
    id: invoiceId,
    invoice_number: null,
    status: "draft",
    voided_at: null,
  }, { appEnv: args.appEnv });

  // 5. Record the Stripe payment and mark the invoice paid.
  await ensureStripePayment(client, invoiceId, {
    paymentDate: args.paymentDate,
    amount: gross,
    stripeInvoiceId: args.stripeInvoiceId,
  });
  await markInvoicePaid(client, invoiceId, args.paymentDate);

  return { invoiceId, invoiceNumber, created: true };
}
