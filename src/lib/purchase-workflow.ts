import type { ParsedInvoice } from './invoice-parser';
import type { SupplierType, VatTreatment } from './accounting-utils';
import { isReverseChargeTreatment } from './accounting-utils';

const EU_COUNTRY_CODES = new Set([
  'AT', 'BE', 'BG', 'HR', 'CY', 'CZ', 'DK', 'EE', 'FI', 'FR', 'DE', 'GR',
  'HU', 'IE', 'IT', 'LV', 'LT', 'LU', 'MT', 'NL', 'PL', 'PT', 'RO', 'SK',
  'SI', 'ES', 'SE',
]);

const INVOICE_NUMBER_NOTE_PREFIXES = [
  'Leverantörens fakturanr:',
  'Supplier invoice no:',
];

export interface PurchaseFormValues {
  supplierId: string;
  newSupplierName: string;
  invoiceNumber: string;
  documentType: string;
  documentDate: string;
  dueDate: string;
  currency: string;
  grossAmount: string;
  vatAmount: string;
  netAmount: string;
  paymentSource: string;
  description: string;
}

export interface OriginalAmountsInput {
  gross: number;
  net: number;
  vat: number;
}

export function createEmptyPurchaseForm(): PurchaseFormValues {
  return {
    supplierId: '',
    newSupplierName: '',
    invoiceNumber: '',
    documentType: 'supplier_invoice',
    documentDate: '',
    dueDate: '',
    currency: 'SEK',
    grossAmount: '',
    vatAmount: '',
    netAmount: '',
    paymentSource: 'owner_paid',
    description: '',
  };
}

export function extractInvoiceNumberFromNotes(notes: string | null | undefined): string {
  if (!notes) return '';

  for (const prefix of INVOICE_NUMBER_NOTE_PREFIXES) {
    if (notes.startsWith(prefix)) {
      return notes.slice(prefix.length).trim();
    }
  }

  return '';
}

export function buildInvoiceNumberNote(invoiceNumber: string): string | null {
  const trimmed = invoiceNumber.trim();
  if (!trimmed) return null;
  return `Supplier invoice no: ${trimmed}`;
}

export function preserveSupplierInvoiceNumber(invoiceNumber: string | null | undefined): string | null {
  const preserved = invoiceNumber?.replace(/\s+/g, ' ').trim() || '';
  return preserved || null;
}

export function normalizeSupplierInvoiceNumber(invoiceNumber: string | null | undefined): string | null {
  const normalized = invoiceNumber
    ?.trim()
    .toUpperCase()
    .replace(/[^A-Z0-9]/g, '') || '';
  return normalized || null;
}

export function findDuplicatePurchaseId(
  purchases: Array<{ id: string; supplier_id: string | null; supplier_invoice_number: string | null }>,
  supplierId: string | null | undefined,
  invoiceNumber: string | null | undefined,
  excludePurchaseId?: string | null,
): string | null {
  const normalizedInvoiceNumber = normalizeSupplierInvoiceNumber(invoiceNumber);
  if (!supplierId || !normalizedInvoiceNumber) return null;

  const match = purchases.find((purchase) =>
    purchase.id !== excludePurchaseId &&
    purchase.supplier_id === supplierId &&
    normalizeSupplierInvoiceNumber(purchase.supplier_invoice_number) === normalizedInvoiceNumber,
  );

  return match?.id || null;
}

export function resolveSavedPurchaseId(
  existingPurchaseId: string | null | undefined,
  createdPurchaseId: string | null | undefined,
): string {
  const resolvedId = existingPurchaseId || createdPurchaseId;
  if (!resolvedId) throw new Error('Purchase id missing after save');
  return resolvedId;
}

export function normalizeVatNumber(vatNumber: string | null | undefined): string | null {
  const trimmed = vatNumber?.replace(/\s+/g, '').trim().toUpperCase();
  return trimmed || null;
}

export function normalizeSupplierName(name: string | null | undefined): string | null {
  const normalized = name
    ?.trim()
    .toUpperCase()
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^A-Z0-9]/g, '') || '';
  return normalized || null;
}

export interface SupplierLookupCandidate {
  id: string;
  name: string;
  vat_number?: string | null;
}

export function findExistingSupplier(
  suppliers: SupplierLookupCandidate[],
  params: {
    supplierName?: string | null;
    vatNumber?: string | null;
  },
): SupplierLookupCandidate | null {
  const normalizedVatNumber = normalizeVatNumber(params.vatNumber);
  if (normalizedVatNumber) {
    const vatMatch = suppliers.find((supplier) => normalizeVatNumber(supplier.vat_number) === normalizedVatNumber);
    if (vatMatch) return vatMatch;
  }

  const normalizedSupplierName = normalizeSupplierName(params.supplierName);
  if (!normalizedSupplierName) return null;

  const exactNameMatch = suppliers.find((supplier) => normalizeSupplierName(supplier.name) === normalizedSupplierName);
  if (exactNameMatch) return exactNameMatch;

  const containingNameMatch = suppliers.find((supplier) => {
    const candidateName = normalizeSupplierName(supplier.name);
    return candidateName && (
      normalizedSupplierName.includes(candidateName) ||
      candidateName.includes(normalizedSupplierName)
    );
  });

  return containingNameMatch || null;
}

function getCountryFromVatNumber(vatNumber: string | null | undefined): string | null {
  const normalized = normalizeVatNumber(vatNumber);
  if (!normalized) return null;
  const match = normalized.match(/^([A-Z]{2})/);
  return match ? match[1] : null;
}

function getSupplierTypeFromCountry(country: string | null): SupplierType {
  if (!country || country === 'SE') return 'domestic';
  return EU_COUNTRY_CODES.has(country) ? 'eu' : 'non_eu';
}

export function inferSupplierMetadata(parsedInvoice: ParsedInvoice | null): {
  country: string;
  supplierType: SupplierType;
  vatNumber: string | null;
} {
  const vatNumber = normalizeVatNumber(parsedInvoice?.vatNumber);
  const country =
    parsedInvoice?.supplierCountry?.trim().toUpperCase() ||
    getCountryFromVatNumber(vatNumber) ||
    'SE';

  return {
    country,
    supplierType: getSupplierTypeFromCountry(country),
    vatNumber,
  };
}

/** Fingerprints known to represent physical goods */
const GOODS_FINGERPRINTS = new Set([
  'elbutik_scandinavia_invoice',
  'cs_megastore_receipt',
  'coolshop_receipt',
  'global_e_invoice',
  'mnu_invoice',
  'digikey_invoice',
  'ubiquiti_receipt_invoice',
  'bbqkees_invoice',
  'amazon_sweden_invoice',
  'amazon_marketplace_invoice',
]);

/** Infer whether a purchase is goods or services based on fingerprint. Defaults to services. */
function inferGoodsOrServices(fingerprintId: string | null | undefined): 'goods' | 'services' {
  if (fingerprintId && GOODS_FINGERPRINTS.has(fingerprintId)) return 'goods';
  return 'services';
}

/** Pick the specific reverse-charge VatTreatment based on supplier type and goods/services classification */
function pickReverseChargeTreatment(supplierType: SupplierType, goodsOrServices: 'goods' | 'services'): VatTreatment {
  if (supplierType === 'eu') {
    return goodsOrServices === 'goods' ? 'reverse_charge_eu_goods' : 'reverse_charge_eu_services';
  }
  // Goods cannot be classified as imported services, even when a document
  // mentions reverse charge. A domestic supplier also needs explicit review.
  return supplierType === 'non_eu' && goodsOrServices === 'services'
    ? 'reverse_charge_non_eu_services'
    : 'needs_review';
}

const DIGITAL_BILLING_SECTIONS: Record<string, RegExp> = {
  apple_subscription_receipt: /Billing and Payment\s+(.+?)\s+Subtotal/i,
  anthropic_invoice: /Bill to\s+(.+?)(?=\s+(?:Ship to|Pay online|Description|[$€]\d))/i,
  lovable_invoice: /Bill to\s+(.+?)(?=\s+(?:Ship to|Pay online|Description|[$€]\d))/i,
};

function hasSwedishChargedVat(invoice: ParsedInvoice | null, text: string): boolean {
  if (normalizeVatNumber(invoice?.vatNumber)?.match(/^SE\d{10,12}$/)) return true;
  if (/vat\s*-\s*sweden/i.test(text)) return true;

  // These recognised digital-service layouts charge destination VAT. Read
  // the purchaser's billing section, not the supplier's Irish/US address or
  // a Swedish shipping address elsewhere in the document.
  const billingPattern = DIGITAL_BILLING_SECTIONS[invoice?.fingerprint.id || ''];
  const billingSection = billingPattern?.exec(text)?.[1];
  return invoice?.fingerprint.recognized === true && invoice.vatRate === 25 &&
    !!billingSection && /\b(?:Sweden|Sverige)\b/i.test(billingSection);
}

function isEuReverseChargeTreatment(vatTreatment: string | null | undefined): boolean {
  return vatTreatment === 'reverse_charge_eu_goods' || vatTreatment === 'reverse_charge_eu_services';
}

export function normalizeEuReverseChargeOriginalAmounts(params: {
  originalAmounts: OriginalAmountsInput;
  vatTreatment: string | null | undefined;
}): OriginalAmountsInput {
  const { gross, net, vat } = params.originalAmounts;
  if (!isEuReverseChargeTreatment(params.vatTreatment) || vat !== 0 || gross <= 0) {
    return { gross, net, vat };
  }

  // EU reverse-charge VAT is due on the full taxable consideration, including shipping and fees.
  return {
    gross,
    net: gross,
    vat: 0,
  };
}

export function inferVatTreatment(params: {
  parsedInvoice: ParsedInvoice | null;
  extractedText: string | null;
  supplierCountry?: string | null;
  supplierType?: string | null;
}): VatTreatment {
  const vatAmount = params.parsedInvoice?.vatAmount ?? null;
  const grossAmount = params.parsedInvoice?.grossAmount ?? null;
  const currency = params.parsedInvoice?.currency ?? null;
  const invoiceSupplier = inferSupplierMetadata(params.parsedInvoice);
  const hasInvoiceSupplierIdentity = params.parsedInvoice?.fingerprint.recognized &&
    !!(params.parsedInvoice.supplierCountry || params.parsedInvoice.vatNumber);
  // Reuploading must use the invoice's evidence even when an existing supplier
  // record still has country/type defaults from a previous bad import.
  const normalizedCountry = hasInvoiceSupplierIdentity
    ? invoiceSupplier.country
    : params.supplierCountry?.toUpperCase() || invoiceSupplier.country;
  const supplierType = hasInvoiceSupplierIdentity
    ? invoiceSupplier.supplierType
    : (params.supplierType as SupplierType | null) || getSupplierTypeFromCountry(normalizedCountry);
  const text = `${params.extractedText || ''} ${params.parsedInvoice?.vatNumber || ''}`.replace(/\s+/g, ' ').toLowerCase();
  const fingerprintId = params.parsedInvoice?.fingerprint.id;
  const goodsOrServices = inferGoodsOrServices(fingerprintId);
  const supplierVatCountry = getCountryFromVatNumber(params.parsedInvoice?.vatNumber);

  if (params.parsedInvoice?.parserReviewRequired) return 'needs_review';

  if (
    (fingerprintId === 'amazon_sweden_invoice' || fingerprintId === 'amazon_marketplace_invoice') &&
    vatAmount !== null &&
    vatAmount > 0 &&
    grossAmount !== null &&
    grossAmount <= 4000 &&
    currency === 'SEK'
  ) {
    return 'domestic_deductible';
  }

  if (vatAmount !== null && vatAmount > 0) {
    if (hasSwedishChargedVat(params.parsedInvoice, text)) return 'domestic_deductible';
    if (/foreign VAT|VAT charged abroad/i.test(text)) return 'non_deductible';
    // A foreign registration does not identify the jurisdiction of charged
    // VAT (destination VAT can be reported through OSS). Without that evidence,
    // review it, including Coolshop's conflicting Swedish/Danish identity.
    if (supplierVatCountry && supplierVatCountry !== 'SE') return 'needs_review';
    return supplierType === 'domestic' ? 'domestic_deductible' : 'needs_review';
  }

  if (
    vatAmount === 0 && goodsOrServices === 'goods' &&
    supplierVatCountry && EU_COUNTRY_CODES.has(supplierVatCountry) && supplierVatCountry !== 'SE' &&
    /intra-community acquisition|gemenskapsinterna förvärv/i.test(text)
  ) {
    // DigiKey invoices identify their EU VAT registration and triangulated
    // acquisition explicitly, despite the supplier's US mailing address.
    return 'reverse_charge_eu_goods';
  }

  if (/(reverse charge|omvänd skattskyldighet|intra-community supply|vat exempt)/i.test(text)) {
    return pickReverseChargeTreatment(supplierType, goodsOrServices);
  }

  if (vatAmount === 0) {
    if (supplierType === 'eu') return pickReverseChargeTreatment('eu', goodsOrServices);
    if (supplierType === 'non_eu') {
      return goodsOrServices === 'services'
        ? 'reverse_charge_non_eu_services'
        : 'needs_review';
    }
    if (/(momsfri|no vat|without vat|ingen moms)/i.test(text)) return 'no_vat';
  }

  return 'needs_review';
}
