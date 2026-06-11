// Sales/income accounting: journal construction for sales invoices and
// customer payments, posting-period resolution against locked periods, and
// VAT declaration box aggregation from posted journal lines.
import { getAccountName, type JournalPreviewLine } from './accounting-utils.ts';
import { roundMoney } from './accounting-fx.ts';

export const AR_ACCOUNT = '1510';            // Kundfordringar
export const BANK_ACCOUNT = '1930';          // Företagskonto
export const STRIPE_CLEARING_ACCOUNT = '1580'; // Stripe clearing
export const SALES_REVENUE_ACCOUNT = '3010'; // Försäljning

/** Output VAT account and Skatteverket sales-VAT box per Swedish VAT rate. */
export const OUTPUT_VAT_BY_RATE: Record<number, { account: string; box: '10' | '11' | '12' }> = {
  25: { account: '2611', box: '10' },
  12: { account: '2621', box: '11' },
  6: { account: '2631', box: '12' },
};

export type CustomerPaymentMethod = 'bankgiro' | 'manual' | 'stripe';

export interface SalesInvoiceLineInput {
  description: string;
  quantity: number;
  unit_price: number;
  tax_rate: number;
}

export interface SalesInvoiceTotals {
  net: number;
  vatByRate: Record<number, number>;
  vat: number;
  gross: number;
}

/** Totals matching the invoice_computed_totals view: VAT rounded per line. */
export function computeSalesInvoiceTotals(lines: SalesInvoiceLineInput[]): SalesInvoiceTotals {
  let net = 0;
  const vatByRate: Record<number, number> = {};
  for (const line of lines) {
    const lineNet = roundMoney(line.quantity * line.unit_price);
    const lineVat = roundMoney(line.quantity * line.unit_price * line.tax_rate / 100);
    net = roundMoney(net + lineNet);
    if (lineVat !== 0) {
      vatByRate[line.tax_rate] = roundMoney((vatByRate[line.tax_rate] || 0) + lineVat);
    }
  }
  const vat = roundMoney(Object.values(vatByRate).reduce((sum, v) => sum + v, 0));
  return { net, vatByRate, vat, gross: roundMoney(net + vat) };
}

/**
 * Journal lines for an ordinary sales invoice:
 *   Debit 1510 Kundfordringar (gross)
 *   Credit 3010 Försäljning (net)
 *   Credit 2611/2621/2631 output VAT per rate
 */
export function buildSalesInvoiceJournalLines(
  lines: SalesInvoiceLineInput[],
  description: string,
): JournalPreviewLine[] {
  const totals = computeSalesInvoiceTotals(lines);
  const journalLines: JournalPreviewLine[] = [
    { account: AR_ACCOUNT, accountName: getAccountName(AR_ACCOUNT), description, debit: totals.gross, credit: 0 },
    { account: SALES_REVENUE_ACCOUNT, accountName: getAccountName(SALES_REVENUE_ACCOUNT), description, debit: 0, credit: totals.net },
  ];
  for (const rate of Object.keys(totals.vatByRate).map(Number).sort((a, b) => b - a)) {
    const vatAccount = OUTPUT_VAT_BY_RATE[rate];
    if (!vatAccount) throw new Error(`Okänd momssats: ${rate}%`);
    journalLines.push({
      account: vatAccount.account,
      accountName: getAccountName(vatAccount.account),
      description,
      debit: 0,
      credit: totals.vatByRate[rate],
    });
  }
  return journalLines;
}

/**
 * Journal lines for a customer payment settling a receivable:
 *   Debit 1930 Företagskonto (bankgiro/manual) or 1580 Stripe clearing (stripe)
 *   Credit 1510 Kundfordringar
 */
export function buildCustomerPaymentJournalLines(
  amount: number,
  method: CustomerPaymentMethod,
  description: string,
): JournalPreviewLine[] {
  const debitAccount = method === 'stripe' ? STRIPE_CLEARING_ACCOUNT : BANK_ACCOUNT;
  return [
    { account: debitAccount, accountName: getAccountName(debitAccount), description, debit: amount, credit: 0 },
    { account: AR_ACCOUNT, accountName: getAccountName(AR_ACCOUNT), description, debit: 0, credit: amount },
  ];
}

export interface AccountingPeriodRow {
  id: string;
  year: number;
  month: number;
  status: string;
}

export interface SalesPostingPeriodResolution {
  period: AccountingPeriodRow;
  verificationDate: string;
  isCorrection: boolean;
}

/**
 * Resolve which accounting period a document dated `documentDate` can be
 * posted into. If the document's own month is open, post there on the
 * document date. If it is locked/closed, post into the first later open
 * period (first day of that month) as an explicit correction. Locked periods
 * are never reopened. Returns null when no open period exists.
 */
export function resolveSalesPostingPeriod(
  documentDate: string,
  periods: AccountingPeriodRow[],
): SalesPostingPeriodResolution | null {
  const doc = new Date(documentDate);
  const docYear = doc.getFullYear();
  const docMonth = doc.getMonth() + 1;

  const own = periods.find(p => p.year === docYear && p.month === docMonth);
  if (own && own.status === 'open') {
    return { period: own, verificationDate: documentDate.slice(0, 10), isCorrection: false };
  }

  const firstOpenAfter = periods
    .filter(p => p.status === 'open' && (p.year > docYear || (p.year === docYear && p.month > docMonth)))
    .sort((a, b) => a.year - b.year || a.month - b.month)[0];
  if (!firstOpenAfter) return null;

  return {
    period: firstOpenAfter,
    verificationDate: `${firstOpenAfter.year}-${String(firstOpenAfter.month).padStart(2, '0')}-01`,
    isCorrection: true,
  };
}

export interface SalesVatBoxes {
  box05: number;
  box10: number;
  box11: number;
  box12: number;
}

/**
 * Aggregate Skatteverket sales boxes from posted journal lines.
 * Box 05 = revenue (3xxx credits), boxes 10/11/12 = output VAT per rate.
 * Computed from accounting truth, never from mutable invoice rows.
 */
export function salesVatBoxesFromJournalLines(
  lines: Array<{ account: string; debit: number | string; credit: number | string }>,
): SalesVatBoxes {
  const creditBalance = (predicate: (account: string) => boolean) =>
    roundMoney(lines
      .filter(l => predicate(l.account))
      .reduce((sum, l) => sum + Number(l.credit) - Number(l.debit), 0));

  return {
    box05: creditBalance(account => account.startsWith('3')),
    box10: creditBalance(account => account === OUTPUT_VAT_BY_RATE[25].account),
    box11: creditBalance(account => account === OUTPUT_VAT_BY_RATE[12].account),
    box12: creditBalance(account => account === OUTPUT_VAT_BY_RATE[6].account),
  };
}

export const SALES_VERIFICATION_SOURCE_TYPES = ['sales_invoice', 'sales_invoice_correction'] as const;

/** Snapshot of invoice facts captured at posting time. */
export interface SalesInvoiceSnapshot {
  invoice_number: string;
  customer_id: string;
  finalized_at: string | null;
  issued_at: string | null;
  due_date: string | null;
  line_items: Array<SalesInvoiceLineInput & { line_type?: string | null }>;
  totals: { subtotal: number; tax: number; total: number };
  vat_rates: number[];
}

export function buildSalesInvoiceSnapshot(params: {
  invoice: {
    invoice_number: string | null;
    customer_id: string;
    finalized_at: string | null;
    issued_at: string | null;
    due_date: string | null;
  };
  lineItems: Array<SalesInvoiceLineInput & { line_type?: string | null }>;
  totals: { subtotal: number; tax: number; total: number };
}): SalesInvoiceSnapshot {
  return {
    invoice_number: params.invoice.invoice_number || '',
    customer_id: params.invoice.customer_id,
    finalized_at: params.invoice.finalized_at,
    issued_at: params.invoice.issued_at,
    due_date: params.invoice.due_date,
    line_items: params.lineItems.map(li => ({
      description: li.description,
      quantity: Number(li.quantity),
      unit_price: Number(li.unit_price),
      tax_rate: Number(li.tax_rate),
      line_type: li.line_type ?? null,
    })),
    totals: params.totals,
    vat_rates: [...new Set(params.lineItems.map(li => Number(li.tax_rate)))].sort((a, b) => b - a),
  };
}
