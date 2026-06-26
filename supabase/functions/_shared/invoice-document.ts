import type { SupabaseClient } from "https://esm.sh/@supabase/supabase-js@2.57.2";
import QRCode from "https://esm.sh/qrcode@1.5.4";
import {
  INVOICE_COMPANY,
  loadBusinessSettings,
  businessSettingsFromSnapshot,
  type BusinessSettings,
} from "./invoice-company.ts";

export interface InvoiceDocumentLineItem {
  id: string;
  line_type: string;
  description: string;
  quantity: number;
  unit_price: number;
  tax_rate: number;
  sku: string | null;
  category: string | null;
  sort_order?: number;
}

export interface InvoiceDocumentPayment {
  id: string;
  payment_date: string;
  amount: number;
  method: string | null;
  reference: string | null;
  note: string | null;
  created_at?: string;
}

export interface InvoicePaymentDetails {
  bankgiro_number: string | null;
  payee_name: string;
  payment_reference: string | null;
  amount: number;
  due_date: string | null;
  currency: string;
  qr_payload: string | null;
  qr_data_url: string | null;
  manual_payment_instruction: string;
}

export interface InvoiceDocumentData {
  id: string;
  invoice_number: string | null;
  status: string | null;
  due_date: string | null;
  currency: string | null;
  subtotal: number | null;
  tax: number | null;
  total: number | null;
  created_at: string;
  finalized_at: string | null;
  issued_at: string | null;
  paid_at: string | null;
  voided_at: string | null;
  quote_number: string | null;
  customer_name: string | null;
  customer_address: {
    street: string | null;
    postcode: string | null;
    city: string | null;
  } | null;
  line_items: InvoiceDocumentLineItem[];
  payments: InvoiceDocumentPayment[];
  payment_details: InvoicePaymentDetails;
  /** Seller business details this invoice was rendered with — the frozen
   *  snapshot for finalized invoices, live settings for drafts. */
  seller: BusinessSettings;
}

interface LoadedInvoiceRow {
  id: string;
  invoice_number: string | null;
  status: string | null;
  due_date: string | null;
  currency: string | null;
  created_at: string;
  finalized_at: string | null;
  issued_at: string | null;
  paid_at: string | null;
  voided_at: string | null;
  quote_number: string | null;
  business_snapshot: unknown;
  customer_snapshot: unknown;
  customer_id: string;
  customer: {
    name: string | null;
    billing_same_as_site: boolean | null;
    site_street: string | null;
    site_postcode: string | null;
    site_city: string | null;
    billing_street: string | null;
    billing_postcode: string | null;
    billing_city: string | null;
  } | null;
}

function getConfiguredBankgiroNumber(): string | null {
  const raw = Deno.env.get("BANKGIRO_NUMBER")?.trim() || "";
  return raw.length > 0 ? raw : null;
}

function formatPaymentAmount(amount: number): string {
  return amount.toFixed(2);
}

function toNumber(value: unknown): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

interface FrozenCustomer {
  name: string | null;
  street: string | null;
  postcode: string | null;
  city: string | null;
}

/** Resolves the frozen buyer details from a document's customer_snapshot, or
 *  null when there is no usable snapshot (draft/legacy — caller uses live data). */
function parseCustomerSnapshot(snapshot: unknown): FrozenCustomer | null {
  if (!snapshot || typeof snapshot !== "object") return null;
  const row = snapshot as Record<string, unknown>;
  const str = (v: unknown): string | null => (typeof v === "string" && v.length > 0 ? v : null);
  return {
    name: str(row.name),
    street: str(row.street),
    postcode: str(row.postcode),
    city: str(row.city),
  };
}

export function buildInvoiceQrPayload(args: {
  bankgiroNumber: string | null;
  payeeName: string;
  invoiceNumber: string | null;
  amount: number;
  currency: string;
  dueDate: string | null;
}): string | null {
  if (!args.bankgiroNumber || !args.invoiceNumber) {
    return null;
  }

  const lines = [
    "SHS-INVOICE-PAYMENT",
    `BANKGIRO:${args.bankgiroNumber}`,
    `PAYEE:${args.payeeName}`,
    `REFERENCE:${args.invoiceNumber}`,
    `AMOUNT:${formatPaymentAmount(args.amount)}`,
    `CURRENCY:${args.currency || "SEK"}`,
  ];

  if (args.dueDate) {
    lines.push(`DUE_DATE:${args.dueDate}`);
  }

  return lines.join("\n");
}

async function buildInvoiceQrDataUrl(qrPayload: string | null): Promise<string | null> {
  if (!qrPayload) {
    return null;
  }

  return await QRCode.toDataURL(qrPayload, {
    errorCorrectionLevel: "M",
    margin: 1,
    width: 256,
  });
}

export async function buildInvoicePaymentDetails(args: {
  invoiceNumber: string | null;
  amount: number;
  dueDate: string | null;
  currency: string | null;
  /** Resolved business settings. When omitted, falls back to the legacy
   *  BANKGIRO_NUMBER secret and the hard-coded company name. */
  settings?: BusinessSettings;
}): Promise<InvoicePaymentDetails> {
  const amount = toNumber(args.amount);
  const bankgiroNumber = args.settings
    ? args.settings.bankgiroNumber
    : getConfiguredBankgiroNumber();
  const payeeName = args.settings?.payeeName || INVOICE_COMPANY.name;
  const currency = args.currency || "SEK";
  const qrPayload = buildInvoiceQrPayload({
    bankgiroNumber,
    payeeName,
    invoiceNumber: args.invoiceNumber,
    amount,
    currency,
    dueDate: args.dueDate,
  });
  const qrDataUrl = await buildInvoiceQrDataUrl(qrPayload);

  const manualPaymentInstruction = bankgiroNumber
    ? `Betala till Bankgiro ${bankgiroNumber} och ange ${args.invoiceNumber || "fakturanummer"} som referens.`
    : `Ange ${args.invoiceNumber || "fakturanummer"} som referens nar du betalar. Bankgiro ar inte konfigurerat an.`;

  return {
    bankgiro_number: bankgiroNumber,
    payee_name: payeeName,
    payment_reference: args.invoiceNumber,
    amount,
    due_date: args.dueDate,
    currency,
    qr_payload: qrPayload,
    qr_data_url: qrDataUrl,
    manual_payment_instruction: manualPaymentInstruction,
  };
}

export async function loadInvoiceDocumentData(
  serviceClient: SupabaseClient,
  invoiceId: string,
): Promise<InvoiceDocumentData> {
  const { data: invoice, error: invoiceError } = await serviceClient
    .from("invoices")
    .select(
      "id, invoice_number, status, due_date, currency, customer_id, created_at, finalized_at, issued_at, paid_at, voided_at, quote_number, business_snapshot, customer_snapshot, customer:customers_with_identity!invoices_customer_id_fkey(name, billing_same_as_site, site_street, site_postcode, site_city, billing_street, billing_postcode, billing_city)",
    )
    .eq("id", invoiceId)
    .single();

  if (invoiceError || !invoice) {
    throw new Error("Invoice not found");
  }

  const typedInvoice = invoice as unknown as LoadedInvoiceRow;

  const [{ data: lineItems }, { data: totals }, { data: payments }] = await Promise.all([
    serviceClient
      .from("invoice_line_items")
      .select("id, line_type, description, quantity, unit_price, tax_rate, sku, category, sort_order")
      .eq("invoice_id", invoiceId)
      .order("sort_order"),
    serviceClient
      .from("invoice_computed_totals")
      .select("subtotal, tax, total")
      .eq("invoice_id", invoiceId)
      .maybeSingle(),
    serviceClient
      .from("invoice_payments")
      .select("id, payment_date, amount, method, reference, note, created_at")
      .eq("invoice_id", invoiceId)
      .order("payment_date"),
  ]);

  const subtotal = toNumber(totals?.subtotal ?? 0);
  const tax = toNumber(totals?.tax ?? 0);
  const total = toNumber(totals?.total ?? 0);
  const useSiteAddress = typedInvoice.customer?.billing_same_as_site === true;
  // Finalized invoices render from their frozen snapshots (seller + buyer);
  // drafts (no snapshot yet) fall back to live data so the preview stays current.
  const settings =
    businessSettingsFromSnapshot(typedInvoice.business_snapshot) ??
    (await loadBusinessSettings(serviceClient));
  const frozenCustomer = parseCustomerSnapshot(typedInvoice.customer_snapshot);
  const paymentDetails = await buildInvoicePaymentDetails({
    invoiceNumber: typedInvoice.invoice_number,
    amount: total,
    dueDate: typedInvoice.due_date,
    currency: typedInvoice.currency,
    settings,
  });

  return {
    id: typedInvoice.id,
    invoice_number: typedInvoice.invoice_number,
    status: typedInvoice.status,
    due_date: typedInvoice.due_date,
    currency: typedInvoice.currency,
    subtotal,
    tax,
    total,
    created_at: typedInvoice.created_at,
    finalized_at: typedInvoice.finalized_at,
    issued_at: typedInvoice.issued_at,
    paid_at: typedInvoice.paid_at,
    voided_at: typedInvoice.voided_at,
    quote_number: typedInvoice.quote_number,
    customer_name: frozenCustomer?.name ?? (typedInvoice.customer?.name || null),
    customer_address: frozenCustomer
      ? {
          street: frozenCustomer.street,
          postcode: frozenCustomer.postcode,
          city: frozenCustomer.city,
        }
      : typedInvoice.customer
        ? {
            street: useSiteAddress ? typedInvoice.customer.site_street : typedInvoice.customer.billing_street,
            postcode: useSiteAddress ? typedInvoice.customer.site_postcode : typedInvoice.customer.billing_postcode,
            city: useSiteAddress ? typedInvoice.customer.site_city : typedInvoice.customer.billing_city,
          }
        : null,
    line_items: (lineItems || []).map((item) => ({
      ...(item as InvoiceDocumentLineItem),
      quantity: toNumber((item as InvoiceDocumentLineItem).quantity),
      unit_price: toNumber((item as InvoiceDocumentLineItem).unit_price),
      tax_rate: toNumber((item as InvoiceDocumentLineItem).tax_rate),
    })) as InvoiceDocumentLineItem[],
    payments: (payments || []).map((payment) => ({
      ...(payment as InvoiceDocumentPayment),
      amount: toNumber((payment as InvoiceDocumentPayment).amount),
    })) as InvoiceDocumentPayment[],
    payment_details: paymentDetails,
    seller: settings,
  };
}
