// Posting of sales invoices and customer payments into the accounting
// journal (acc_verifications + acc_journal_lines), with idempotency guards
// and explicit correction handling for invoices belonging to locked periods.
import type { SupabaseClient } from '@supabase/supabase-js';
import type { Database } from '@/integrations/supabase/types';
import { allocateNextVerificationNumber } from '@/lib/verification-number';
import {
  buildCustomerPaymentJournalLines,
  buildSalesInvoiceJournalLines,
  buildSalesInvoiceSnapshot,
  resolveSalesPostingPeriod,
  type CustomerPaymentMethod,
  type SalesInvoiceLineInput,
} from '@/lib/sales-accounting';
import type { JournalPreviewLine } from '@/lib/accounting-utils';

type Supabase = SupabaseClient<Database>;

export interface PostableInvoice {
  id: string;
  invoice_number: string | null;
  customer_id: string;
  status: string | null;
  finalized_at: string | null;
  issued_at: string | null;
  due_date: string | null;
  voided_at: string | null;
}

/** The date an invoice belongs to economically: issue date, else finalized date. */
export function getInvoiceEconomicDate(invoice: Pick<PostableInvoice, 'issued_at' | 'finalized_at'>): string | null {
  const date = invoice.issued_at || invoice.finalized_at;
  return date ? date.slice(0, 10) : null;
}

export function isInvoicePostable(invoice: PostableInvoice): boolean {
  return Boolean(invoice.finalized_at) && !invoice.voided_at && invoice.status !== 'void' && invoice.status !== 'draft';
}

async function insertJournalLines(
  supabase: Supabase,
  verificationId: string,
  lines: JournalPreviewLine[],
): Promise<void> {
  const { error } = await supabase.from('acc_journal_lines').insert(lines.map((line, i) => ({
    verification_id: verificationId,
    account: line.account,
    account_name: line.accountName,
    description: line.description,
    debit: line.debit,
    credit: line.credit,
    sort_order: i,
    original_currency: 'SEK',
    exchange_rate_source: 'SEK',
    converted_amount_sek: line.debit > 0 ? line.debit : line.credit,
  })));
  if (error) throw error;
}

export interface PostSalesInvoiceParams {
  supabase: Supabase;
  userId: string | undefined;
  invoice: PostableInvoice;
  lineItems: Array<SalesInvoiceLineInput & { line_type?: string | null }>;
  totals: { subtotal: number; tax: number; total: number };
  correctionReason?: string;
}

export interface PostSalesInvoiceResult {
  verificationNumber: string;
  isCorrection: boolean;
}

/**
 * Post a finalized sales invoice to accounting. If the invoice's own period
 * is locked (e.g. filed VAT quarter), the posting lands in the first open
 * period as an explicit correction — the locked period and its filed VAT
 * snapshot are never touched.
 */
export async function postSalesInvoice(params: PostSalesInvoiceParams): Promise<PostSalesInvoiceResult> {
  const { supabase, userId, invoice, lineItems, totals, correctionReason } = params;

  if (!isInvoicePostable(invoice)) {
    throw new Error('Endast slutförda, ej makulerade fakturor kan bokföras.');
  }
  const economicDate = getInvoiceEconomicDate(invoice);
  if (!economicDate) throw new Error('Fakturan saknar datum.');

  const { data: existingLink } = await supabase
    .from('acc_sales_invoice_links')
    .select('id')
    .eq('invoice_id', invoice.id)
    .maybeSingle();
  if (existingLink) throw new Error('Fakturan är redan bokförd.');

  const { data: periods, error: periodsError } = await supabase
    .from('acc_periods')
    .select('id, year, month, status');
  if (periodsError) throw periodsError;

  const resolution = resolveSalesPostingPeriod(economicDate, periods || []);
  if (!resolution) throw new Error('Ingen öppen bokföringsperiod hittades.');
  if (resolution.isCorrection && !correctionReason?.trim()) {
    throw new Error('Ange anledning till korrigeringen.');
  }

  const description = resolution.isCorrection
    ? `Korrigering: försäljningsfaktura ${invoice.invoice_number} (fakturadatum ${economicDate}, ursprunglig period låst)`
    : `Försäljningsfaktura ${invoice.invoice_number}`;

  const verificationNumber = await allocateNextVerificationNumber(supabase, resolution.verificationDate);
  const { data: verification, error: vErr } = await supabase.from('acc_verifications').insert({
    verification_number: verificationNumber,
    verification_date: resolution.verificationDate,
    description,
    period_id: resolution.period.id,
    source_type: resolution.isCorrection ? 'sales_invoice_correction' : 'sales_invoice',
    source_id: invoice.id,
    is_posted: true,
    posted_at: new Date().toISOString(),
    posted_by: userId,
    created_by: userId,
  }).select().single();
  if (vErr) throw vErr;

  await insertJournalLines(supabase, verification.id, buildSalesInvoiceJournalLines(lineItems, description));

  const snapshot = buildSalesInvoiceSnapshot({ invoice, lineItems, totals });
  const { error: linkError } = await supabase.from('acc_sales_invoice_links').insert({
    invoice_id: invoice.id,
    verification_id: verification.id,
    source_snapshot_json: {
      ...snapshot,
      ...(resolution.isCorrection ? {
        correction: {
          reason: correctionReason!.trim(),
          original_invoice_date: economicDate,
          original_finalized_at: invoice.finalized_at,
          posted_into_period: `${resolution.period.year}-${String(resolution.period.month).padStart(2, '0')}`,
        },
      } : {}),
    } as never,
    posted_at: new Date().toISOString(),
    posted_by: userId ?? null,
    posting_reason: resolution.isCorrection ? `correction: ${correctionReason!.trim()}` : 'ordinary',
  });
  if (linkError) throw linkError;

  return { verificationNumber, isCorrection: resolution.isCorrection };
}

export interface RecordCustomerPaymentParams {
  supabase: Supabase;
  userId: string | undefined;
  invoice: Pick<PostableInvoice, 'id' | 'invoice_number'>;
  paymentDate: string;
  amount: number;
  method: CustomerPaymentMethod;
  note?: string;
}

/**
 * Record a customer payment on an invoice and post it to accounting.
 * Idempotent: the unique (invoice_id, payment_date, amount, method)
 * constraint rejects duplicate recordings, and the unique
 * (source_type, source_id) constraint rejects duplicate postings.
 * Stripe payments settle via 1580 Stripe clearing — no fee or payout is
 * inferred; any remaining clearing balance is surfaced by integrity checks.
 */
export async function recordAndPostCustomerPayment(params: RecordCustomerPaymentParams): Promise<string> {
  const { supabase, userId, invoice, paymentDate, amount, method, note } = params;
  if (!(amount > 0)) throw new Error('Beloppet måste vara större än 0.');

  // Reuse an identical already-recorded payment so a failed posting can be
  // retried without creating a duplicate payment row.
  const { data: existingPayment } = await supabase
    .from('invoice_payments')
    .select('id')
    .eq('invoice_id', invoice.id)
    .eq('payment_date', paymentDate)
    .eq('amount', amount)
    .eq('method', method)
    .maybeSingle();

  let payment = existingPayment;
  if (!payment) {
    const { data: inserted, error: paymentError } = await supabase.from('invoice_payments').insert({
      invoice_id: invoice.id,
      payment_date: paymentDate,
      amount,
      method,
      note: note || null,
      created_by: userId ?? null,
    }).select().single();
    if (paymentError) {
      if (paymentError.code === '23505') {
        throw new Error('Denna betalning är redan registrerad (samma faktura, datum, belopp och metod).');
      }
      throw paymentError;
    }
    payment = inserted;
  }

  const { data: existingVerification } = await supabase
    .from('acc_verifications')
    .select('verification_number')
    .eq('source_type', 'customer_payment')
    .eq('source_id', payment.id)
    .maybeSingle();
  if (existingVerification) {
    throw new Error('Denna betalning är redan bokförd.');
  }

  const { data: periods, error: periodsError } = await supabase
    .from('acc_periods')
    .select('id, year, month, status');
  if (periodsError) throw periodsError;
  const resolution = resolveSalesPostingPeriod(paymentDate, periods || []);
  if (!resolution) throw new Error('Ingen öppen bokföringsperiod hittades.');

  const description = `Kundbetalning ${invoice.invoice_number} (${method})`;
  const verificationNumber = await allocateNextVerificationNumber(supabase, resolution.verificationDate);
  const { data: verification, error: vErr } = await supabase.from('acc_verifications').insert({
    verification_number: verificationNumber,
    verification_date: resolution.verificationDate,
    description,
    period_id: resolution.period.id,
    source_type: 'customer_payment',
    source_id: payment.id,
    is_posted: true,
    posted_at: new Date().toISOString(),
    posted_by: userId,
    created_by: userId,
  }).select().single();
  if (vErr) throw vErr;

  await insertJournalLines(supabase, verification.id, buildCustomerPaymentJournalLines(amount, method, description));

  return verificationNumber;
}
