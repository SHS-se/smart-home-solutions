// Accounting utility functions
function roundMoney(amount: number): number {
  return Math.round((amount + 1e-9) * 100) / 100;
}

export type PaymentSource = 'owner_paid' | 'company_bank';
export type PurchaseStatus = 'draft' | 'in_review' | 'blocked' | 'posted';
export type VatTreatment =
  | 'domestic_deductible'            // Swedish purchase with deductible input VAT (→ Box 48)
  | 'reverse_charge_eu_goods'        // Goods from another EU country (→ Box 20, 30, 48)
  | 'reverse_charge_eu_services'     // Services from another EU country (→ Box 21, 30, 48)
  | 'reverse_charge_non_eu_services' // Services from outside EU (→ Box 22, 30, 48)
  | 'non_deductible'                 // Foreign VAT not deductible
  | 'no_vat'                         // Zero-rated / VAT-exempt
  | 'needs_review';                  // Pending classification

/** Returns true for any reverse-charge VAT treatment */
export function isReverseChargeTreatment(treatment: string): boolean {
  return treatment === 'reverse_charge_eu_goods' ||
         treatment === 'reverse_charge_eu_services' ||
         treatment === 'reverse_charge_non_eu_services';
}
export type PeriodStatus = 'open' | 'review' | 'closed' | 'locked';
export type VatPeriodStatus = 'open' | 'in_review' | 'approved' | 'filed' | 'locked';
export type DocumentQualityStatus = 'pending' | 'sufficient' | 'insufficient' | 'not_checked';
export type VatEvidenceStatus = 'pending' | 'sufficient' | 'insufficient' | 'not_applicable';
export type SupplierType = 'domestic' | 'eu' | 'non_eu';

export const PAYMENT_SOURCE_LABELS: Record<PaymentSource, string> = {
  owner_paid: 'Egna medel (2018)',
  company_bank: 'Företagskonto (1930)',
};

export const PAYMENT_SOURCE_LABELS_EN: Record<PaymentSource, string> = {
  owner_paid: 'Owner funds (2018)',
  company_bank: 'Company bank (1930)',
};

export const PURCHASE_STATUS_LABELS: Record<PurchaseStatus, string> = {
  draft: 'Utkast',
  in_review: 'Granskning',
  blocked: 'Blockerad',
  posted: 'Bokförd',
};

export const PURCHASE_STATUS_LABELS_EN: Record<PurchaseStatus, string> = {
  draft: 'Draft',
  in_review: 'In review',
  blocked: 'Blocked',
  posted: 'Posted',
};

export const PURCHASE_STATUS_COLORS: Record<PurchaseStatus, string> = {
  draft: 'bg-muted text-muted-foreground',
  in_review: 'bg-amber-100 text-amber-800',
  blocked: 'bg-red-100 text-red-800',
  posted: 'bg-green-100 text-green-800',
};

export const VAT_TREATMENT_LABELS: Record<VatTreatment, string> = {
  domestic_deductible: 'Ingående moms 25%',
  reverse_charge_eu_goods: 'Omvänd skattskyldighet – EU varor (ruta 20)',
  reverse_charge_eu_services: 'Omvänd skattskyldighet – EU tjänster (ruta 21)',
  reverse_charge_non_eu_services: 'Omvänd skattskyldighet – utom-EU tjänster (ruta 22)',
  non_deductible: 'Ej avdragsgill moms',
  no_vat: 'Ingen moms',
  needs_review: 'Kräver granskning',
};

export const VAT_TREATMENT_LABELS_EN: Record<VatTreatment, string> = {
  domestic_deductible: 'Input VAT 25%',
  reverse_charge_eu_goods: 'Reverse charge – EU goods (box 20)',
  reverse_charge_eu_services: 'Reverse charge – EU services (box 21)',
  reverse_charge_non_eu_services: 'Reverse charge – non-EU services (box 22)',
  non_deductible: 'Non-deductible VAT',
  no_vat: 'No VAT',
  needs_review: 'Needs review',
};

export const PERIOD_STATUS_LABELS: Record<PeriodStatus, string> = {
  open: 'Öppen',
  review: 'Granskning',
  closed: 'Stängd',
  locked: 'Låst',
};

export const PERIOD_STATUS_LABELS_EN: Record<PeriodStatus, string> = {
  open: 'Open',
  review: 'Review',
  closed: 'Closed',
  locked: 'Locked',
};

export const PERIOD_STATUS_COLORS: Record<PeriodStatus, string> = {
  open: 'bg-green-100 text-green-800',
  review: 'bg-amber-100 text-amber-800',
  closed: 'bg-muted text-muted-foreground',
  locked: 'bg-primary/10 text-primary',
};

export const MONTH_NAMES_SV = [
  '', 'Januari', 'Februari', 'Mars', 'April', 'Maj', 'Juni',
  'Juli', 'Augusti', 'September', 'Oktober', 'November', 'December',
];

export const MONTH_NAMES_EN = [
  '', 'January', 'February', 'March', 'April', 'May', 'June',
  'July', 'August', 'September', 'October', 'November', 'December',
];

export const QUARTER_LABELS: Record<number, string> = {
  1: 'Q1',
  2: 'Q2',
  3: 'Q3',
  4: 'Q4',
};

export const QUARTER_MONTHS: Record<number, string> = {
  1: 'Jan – Mar',
  2: 'Apr – Jun',
  3: 'Jul – Sep',
  4: 'Okt – Dec',
};

export function formatSEK(amount: number): string {
  return new Intl.NumberFormat('sv-SE', {
    style: 'decimal',
    minimumFractionDigits: 0,
    maximumFractionDigits: 0,
  }).format(amount) + ' kr';
}

export function formatSEKDecimal(amount: number): string {
  return new Intl.NumberFormat('sv-SE', {
    style: 'decimal',
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  }).format(amount) + ' kr';
}

export function formatExchangeRate(rate: number | null | undefined): string {
  if (rate == null || !Number.isFinite(rate)) return '—';
  return new Intl.NumberFormat('sv-SE', {
    style: 'decimal',
    minimumFractionDigits: 4,
    maximumFractionDigits: 6,
  }).format(rate);
}

/** Credit account based on payment source */
export function getCreditAccount(paymentSource: PaymentSource): { account: string; name: string } {
  return paymentSource === 'owner_paid'
    ? { account: '2018', name: 'Egna insättningar' }
    : { account: '1930', name: 'Företagskonto' };
}

/** Common Swedish BAS account names */
export const ACCOUNT_NAMES: Record<string, string> = {
  '1930': 'Företagskonto',
  '2018': 'Egna insättningar',
  '2641': 'Ingående moms',
  '2614': 'Utgående moms, omvänd skattskyldighet',
  '2645': 'Ingående moms, omvänd skattskyldighet',
  '4000': 'Material och varor',
  '4010': 'Material',
  '4400': 'Övriga inköp',
  '4531': 'Import av varor, EU',
  '5400': 'Förbrukningsinventarier',
  '5410': 'Förbrukningsinventarier',
  '5420': 'Programvaror',
  '5460': 'Förbrukningsmaterial',
  '5800': 'Resekostnader',
  '6100': 'Kontorsmaterial',
  '6200': 'Telefon och internet',
  '6250': 'Datakommunikation',
  '6300': 'Företagsförsäkringar',
  '6530': 'Redovisningstjänster',
  '6540': 'IT-tjänster',
  '6570': 'Bankkostnader',
  '6590': 'Övriga externa tjänster',
  '7600': 'Övriga personalkostnader',
};

export function getAccountName(account: string): string {
  return ACCOUNT_NAMES[account] || '';
}

const FINGERPRINT_ACCOUNT_MAP: Record<string, string> = {
  stripe_tax_invoice:         '6590',
  openai_invoice:             '6540',
  anthropic_invoice:          '6540',
  lovable_invoice:            '6540',
  ubiquiti_receipt_invoice:   '5410',
  amazon_sweden_invoice:      '5410',
  amazon_marketplace_invoice: '5410',
};

const SUPPLIER_NAME_ACCOUNT_RULES: Array<{ pattern: RegExp; account: string }> = [
  { pattern: /\bwebhallen\b/i, account: '5410' },
  { pattern: /\bamazon\b/i,    account: '5410' },
  { pattern: /\bkomplett\b/i,  account: '5410' },
  { pattern: /\bopenai\b/i,    account: '6540' },
  { pattern: /\banthrop/i,     account: '6540' },
  { pattern: /\blovable\b/i,   account: '6540' },
  { pattern: /\bstripe\b/i,    account: '6590' },
];

export function suggestExpenseAccount(
  fingerprintId: string | null | undefined,
  supplierName: string | null | undefined,
): string {
  if (fingerprintId && FINGERPRINT_ACCOUNT_MAP[fingerprintId]) {
    return FINGERPRINT_ACCOUNT_MAP[fingerprintId];
  }
  if (supplierName) {
    for (const rule of SUPPLIER_NAME_ACCOUNT_RULES) {
      if (rule.pattern.test(supplierName)) return rule.account;
    }
  }
  return '4000';
}

/** Build journal preview lines for a purchase */
export interface JournalPreviewLine {
  account: string;
  accountName: string;
  description: string;
  debit: number;
  credit: number;
}

export function buildJournalPreview(
  lines: Array<{ expense_account: string; vat_treatment: VatTreatment; net_amount: number; vat_amount: number; gross_amount: number; description: string }>,
  paymentSource: PaymentSource,
  purchaseDescription: string,
): JournalPreviewLine[] {
  const journalLines: JournalPreviewLine[] = [];
  const creditAccount = getCreditAccount(paymentSource);
  let totalCredit = 0;

  for (const line of lines) {
    // Debit expense account
    if (line.vat_treatment === 'domestic_deductible') {
      journalLines.push({
        account: line.expense_account,
        accountName: getAccountName(line.expense_account) || line.description,
        description: purchaseDescription,
        debit: line.net_amount,
        credit: 0,
      });
      // Debit input VAT
      journalLines.push({
        account: '2641',
        accountName: 'Ingående moms',
        description: purchaseDescription,
        debit: line.vat_amount,
        credit: 0,
      });
      totalCredit += line.gross_amount;
    } else if (isReverseChargeTreatment(line.vat_treatment)) {
      // Expense at net
      journalLines.push({
        account: line.expense_account,
        accountName: getAccountName(line.expense_account) || line.description,
        description: purchaseDescription,
        debit: line.net_amount,
        credit: 0,
      });
      // Deemed output VAT (reverse charge)
      const rcVat = roundMoney(line.net_amount * 0.25);
      journalLines.push({
        account: '2614',
        accountName: 'Utgående moms, omvänd skattskyldighet',
        description: purchaseDescription,
        debit: 0,
        credit: rcVat,
      });
      // Deductible input VAT (reverse charge)
      journalLines.push({
        account: '2645',
        accountName: 'Ingående moms, omvänd skattskyldighet',
        description: purchaseDescription,
        debit: rcVat,
        credit: 0,
      });
      totalCredit += line.net_amount;
    } else if (line.vat_treatment === 'non_deductible') {
      // Full gross to expense (VAT not deducted)
      journalLines.push({
        account: line.expense_account,
        accountName: getAccountName(line.expense_account) || line.description,
        description: purchaseDescription,
        debit: line.gross_amount,
        credit: 0,
      });
      totalCredit += line.gross_amount;
    } else if (line.vat_treatment === 'no_vat') {
      journalLines.push({
        account: line.expense_account,
        accountName: getAccountName(line.expense_account) || line.description,
        description: purchaseDescription,
        debit: line.net_amount,
        credit: 0,
      });
      totalCredit += line.net_amount;
    } else {
      // needs_review — still show but flag
      journalLines.push({
        account: line.expense_account,
        accountName: getAccountName(line.expense_account) || '⚠ Kräver granskning',
        description: purchaseDescription,
        debit: line.gross_amount,
        credit: 0,
      });
      totalCredit += line.gross_amount;
    }
  }

  // Credit payment source
  if (totalCredit > 0) {
    journalLines.push({
      account: creditAccount.account,
      accountName: creditAccount.name,
      description: purchaseDescription,
      debit: 0,
      credit: totalCredit,
    });
  }

  return journalLines;
}

/** Check if a purchase has blocking issues */
export interface PurchaseBlocker {
  type: 'error' | 'warning';
  message: string;
}

export function getPurchaseBlockers(purchase: {
  status: string;
  document_quality_status: string;
  vat_evidence_status: string;
  supplier_id: string | null;
  lines: Array<{ vat_treatment: string; net_amount: number; vat_amount: number; gross_amount: number }>;
  gross_amount: number;
  net_amount: number;
  vat_amount: number;
}): PurchaseBlocker[] {
  const blockers: PurchaseBlocker[] = [];

  if (!purchase.supplier_id) {
    blockers.push({ type: 'error', message: 'Leverantör saknas' });
  }

  if (purchase.lines.length === 0) {
    blockers.push({ type: 'error', message: 'Inga rader klassificerade' });
  }

  const hasNeedsReview = purchase.lines.some(l => l.vat_treatment === 'needs_review');
  if (hasNeedsReview) {
    blockers.push({ type: 'error', message: 'Momsbehandling ej klassificerad på alla rader' });
  }

  // Check line totals match header
  const lineTotal = purchase.lines.reduce((sum, l) => sum + l.gross_amount, 0);
  if (purchase.lines.length > 0 && Math.abs(lineTotal - purchase.gross_amount) > 0.5) {
    blockers.push({ type: 'error', message: 'Radbelopp stämmer inte med totalbelopp' });
  }

  if (purchase.document_quality_status === 'insufficient') {
    blockers.push({ type: 'warning', message: 'Dokumentkvalitet otillräcklig' });
  }

  if (purchase.vat_evidence_status === 'insufficient') {
    const hasDeductible = purchase.lines.some(l => l.vat_treatment === 'domestic_deductible');
    if (hasDeductible) {
      blockers.push({ type: 'error', message: 'Avdragsgill moms begärd trots otillräckligt underlag' });
    }
  }

  return blockers;
}
