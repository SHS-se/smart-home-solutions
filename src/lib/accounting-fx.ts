import type { VatTreatment } from './accounting-utils';

export const BASE_CURRENCY = 'SEK';
const ROUNDING_EPSILON = 1e-9;

export type ExchangeRateSource = 'SEK' | 'ECB' | 'MANUAL_OVERRIDE' | 'LEGACY_UNCONVERTED';

export interface MonetaryAmounts {
  gross: number;
  net: number;
  vat: number;
}

export interface ExchangeRateLookupResult {
  currency: string;
  rate: number;
  rateDate: string;
  source: 'SEK' | 'ECB';
}

export interface PurchaseExchangeSnapshot extends MonetaryAmounts {
  originalCurrency: string;
  originalGross: number;
  originalNet: number;
  originalVat: number;
  exchangeRateSource: ExchangeRateSource;
  exchangeRateDate: string | null;
  exchangeRate: number | null;
  exchangeRateOverridden: boolean;
  exchangeRateOverrideReason: string | null;
  ecbExchangeRate: number | null;
  ecbExchangeRateDate: string | null;
  convertedGrossSek: number;
  convertedNetSek: number;
  convertedVatSek: number;
}

export interface PurchaseLineAmounts {
  id?: string;
  description?: string;
  expense_account: string;
  vat_treatment: VatTreatment;
  gross_amount: number;
  net_amount: number;
  vat_amount: number;
}

export interface PurchaseVatSummary {
  paymentAccountAmountSek: number;
  deductibleInputVatSek: number;
  reverseChargeBaseSek: number;
  reverseChargeOutputVatSek: number;
  reverseChargeInputVatSek: number;
  nonDeductibleVatIncludedSek: number;
  totalGrossSek: number;
  totalOriginalGross: number;
  totalOriginalNet: number;
  totalOriginalVat: number;
  originalCurrency: string;
}

export interface DetectedCurrencyIntegrityIssue {
  reason: string;
  stored: PurchaseExchangeSnapshot;
  expected: PurchaseExchangeSnapshot;
  status: 'draft_requires_backfill' | 'posted_requires_backfill';
}

export interface PurchaseLike {
  currency?: string | null;
  original_currency?: string | null;
  gross_amount?: number | string | null;
  net_amount?: number | string | null;
  vat_amount?: number | string | null;
  original_gross_amount?: number | string | null;
  original_net_amount?: number | string | null;
  original_vat_amount?: number | string | null;
  exchange_rate_source?: string | null;
  exchange_rate_date?: string | null;
  exchange_rate?: number | string | null;
  exchange_rate_overridden?: boolean | null;
  exchange_rate_override_reason?: string | null;
  ecb_exchange_rate?: number | string | null;
  ecb_exchange_rate_date?: string | null;
  converted_gross_amount_sek?: number | string | null;
  converted_net_amount_sek?: number | string | null;
  converted_vat_amount_sek?: number | string | null;
  document_date?: string | null;
  status?: string | null;
}

export function normalizeCurrency(currency: string | null | undefined): string {
  const normalized = currency?.trim().toUpperCase();
  return normalized || BASE_CURRENCY;
}

export function isForeignCurrency(currency: string | null | undefined): boolean {
  return normalizeCurrency(currency) !== BASE_CURRENCY;
}

export function roundMoney(amount: number): number {
  return Math.round((amount + ROUNDING_EPSILON) * 100) / 100;
}

export function parseAmount(value: number | string | null | undefined): number {
  if (typeof value === 'number') return Number.isFinite(value) ? value : 0;
  if (typeof value === 'string') {
    const normalized = Number(value);
    return Number.isFinite(normalized) ? normalized : 0;
  }
  return 0;
}

export function formatCurrencyAmount(amount: number, currency: string, locale = 'sv-SE'): string {
  return `${new Intl.NumberFormat(locale, {
    style: 'decimal',
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  }).format(amount)} ${normalizeCurrency(currency)}`;
}

export function convertDocumentAmounts(amounts: MonetaryAmounts, rate: number): MonetaryAmounts {
  const gross = roundMoney(amounts.gross * rate);
  const net = roundMoney(amounts.net * rate);
  return { gross, net, vat: roundMoney(gross - net) };
}

export function buildExchangeSnapshot(params: {
  documentDate: string;
  currency: string;
  originalAmounts: MonetaryAmounts;
  lookup: ExchangeRateLookupResult;
  overrideRate?: number | null;
  overrideReason?: string | null;
}): PurchaseExchangeSnapshot {
  const originalCurrency = normalizeCurrency(params.currency);
  const finalRate = originalCurrency === BASE_CURRENCY
    ? 1
    : params.overrideRate ?? params.lookup.rate;
  const converted = convertDocumentAmounts(params.originalAmounts, finalRate);
  const isManualOverride = originalCurrency !== BASE_CURRENCY && params.overrideRate != null;

  return {
    gross: converted.gross,
    net: converted.net,
    vat: converted.vat,
    originalCurrency,
    originalGross: roundMoney(params.originalAmounts.gross),
    originalNet: roundMoney(params.originalAmounts.net),
    originalVat: roundMoney(params.originalAmounts.vat),
    exchangeRateSource: originalCurrency === BASE_CURRENCY
      ? 'SEK'
      : isManualOverride
        ? 'MANUAL_OVERRIDE'
        : 'ECB',
    exchangeRateDate: originalCurrency === BASE_CURRENCY ? params.documentDate : params.lookup.rateDate,
    exchangeRate: originalCurrency === BASE_CURRENCY ? 1 : finalRate,
    exchangeRateOverridden: isManualOverride,
    exchangeRateOverrideReason: isManualOverride ? (params.overrideReason?.trim() || null) : null,
    ecbExchangeRate: originalCurrency === BASE_CURRENCY ? 1 : params.lookup.rate,
    ecbExchangeRateDate: originalCurrency === BASE_CURRENCY ? params.documentDate : params.lookup.rateDate,
    convertedGrossSek: converted.gross,
    convertedNetSek: converted.net,
    convertedVatSek: converted.vat,
  };
}

export function getPurchaseExchangeSnapshot(purchase?: PurchaseLike | null): PurchaseExchangeSnapshot {
  const safePurchase = purchase ?? {};
  const originalCurrency = normalizeCurrency(safePurchase.original_currency || safePurchase.currency);
  const originalGross = parseAmount(safePurchase.original_gross_amount ?? safePurchase.gross_amount);
  const originalNet = parseAmount(safePurchase.original_net_amount ?? safePurchase.net_amount);
  const originalVat = parseAmount(safePurchase.original_vat_amount ?? safePurchase.vat_amount);
  const convertedGrossSek = parseAmount(safePurchase.converted_gross_amount_sek ?? safePurchase.gross_amount);
  const convertedNetSek = parseAmount(safePurchase.converted_net_amount_sek ?? safePurchase.net_amount);
  const convertedVatSek = parseAmount(safePurchase.converted_vat_amount_sek ?? safePurchase.vat_amount);

  return {
    gross: convertedGrossSek,
    net: convertedNetSek,
    vat: convertedVatSek,
    originalCurrency,
    originalGross,
    originalNet,
    originalVat,
    exchangeRateSource: (safePurchase.exchange_rate_source as ExchangeRateSource | null) || (originalCurrency === BASE_CURRENCY ? 'SEK' : 'LEGACY_UNCONVERTED'),
    exchangeRateDate: safePurchase.exchange_rate_date || safePurchase.document_date || null,
    exchangeRate: parseAmount(safePurchase.exchange_rate),
    exchangeRateOverridden: Boolean(safePurchase.exchange_rate_overridden),
    exchangeRateOverrideReason: safePurchase.exchange_rate_override_reason || null,
    ecbExchangeRate: parseAmount(safePurchase.ecb_exchange_rate),
    ecbExchangeRateDate: safePurchase.ecb_exchange_rate_date || null,
    convertedGrossSek,
    convertedNetSek,
    convertedVatSek,
  };
}

export function buildPurchasePersistence(snapshot: PurchaseExchangeSnapshot) {
  return {
    currency: snapshot.originalCurrency,
    gross_amount: snapshot.convertedGrossSek,
    net_amount: snapshot.convertedNetSek,
    vat_amount: snapshot.convertedVatSek,
    original_currency: snapshot.originalCurrency,
    original_gross_amount: snapshot.originalGross,
    original_net_amount: snapshot.originalNet,
    original_vat_amount: snapshot.originalVat,
    exchange_rate_source: snapshot.exchangeRateSource,
    exchange_rate_date: snapshot.exchangeRateDate,
    exchange_rate: snapshot.exchangeRate,
    exchange_rate_overridden: snapshot.exchangeRateOverridden,
    exchange_rate_override_reason: snapshot.exchangeRateOverrideReason,
    ecb_exchange_rate: snapshot.ecbExchangeRate,
    ecb_exchange_rate_date: snapshot.ecbExchangeRateDate,
    converted_gross_amount_sek: snapshot.convertedGrossSek,
    converted_net_amount_sek: snapshot.convertedNetSek,
    converted_vat_amount_sek: snapshot.convertedVatSek,
  };
}

function allocateRoundedShares(total: number, weights: number[]): number[] {
  if (weights.length === 0) return [];
  const weightSum = weights.reduce((sum, weight) => sum + Math.max(0, weight), 0);
  if (weightSum <= 0) {
    const empty = new Array(weights.length).fill(0);
    empty[0] = roundMoney(total);
    return empty;
  }

  const rawShares = weights.map((weight) => (total * Math.max(0, weight)) / weightSum);
  const roundedShares = rawShares.map((value) => roundMoney(value));
  const allocated = roundMoney(roundedShares.reduce((sum, value) => sum + value, 0));
  const delta = roundMoney(total - allocated);
  roundedShares[roundedShares.length - 1] = roundMoney(roundedShares[roundedShares.length - 1] + delta);
  return roundedShares;
}

export function allocateConvertedLineAmounts<T extends PurchaseLineAmounts>(
  lines: T[],
  snapshot: PurchaseExchangeSnapshot,
): T[] {
  if (lines.length === 0) return [];

  const grossWeights = lines.map((line) => parseAmount(line.gross_amount));
  const netWeights = lines.map((line) => parseAmount(line.net_amount));
  const vatWeights = lines.map((line) => parseAmount(line.vat_amount));

  const allocatedGross = allocateRoundedShares(snapshot.convertedGrossSek, grossWeights);
  const allocatedNet = allocateRoundedShares(snapshot.convertedNetSek, netWeights);
  const allocatedVat = allocateRoundedShares(snapshot.convertedVatSek, vatWeights);

  return lines.map((line, index) => ({
    ...line,
    gross_amount: allocatedGross[index],
    net_amount: allocatedNet[index],
    vat_amount: allocatedVat[index],
  }));
}

export function buildPurchaseVatSummary(lines: PurchaseLineAmounts[], snapshot: PurchaseExchangeSnapshot): PurchaseVatSummary {
  const deductibleInputVatSek = roundMoney(lines
    .filter((line) => line.vat_treatment === 'domestic_deductible')
    .reduce((sum, line) => sum + parseAmount(line.vat_amount), 0));
  const reverseChargeBaseSek = roundMoney(lines
    .filter((line) => line.vat_treatment === 'reverse_charge')
    .reduce((sum, line) => sum + parseAmount(line.net_amount), 0));
  const reverseChargeVatLines = lines
    .filter((line) => line.vat_treatment === 'reverse_charge')
    .map((line) => roundMoney(parseAmount(line.net_amount) * 0.25));
  const reverseChargeOutputVatSek = roundMoney(reverseChargeVatLines.reduce((sum, amount) => sum + amount, 0));
  const reverseChargeInputVatSek = reverseChargeOutputVatSek;
  const nonDeductibleVatIncludedSek = roundMoney(lines
    .filter((line) => line.vat_treatment === 'non_deductible')
    .reduce((sum, line) => sum + parseAmount(line.gross_amount) - parseAmount(line.net_amount), 0));

  const paymentAccountAmountSek = roundMoney(lines.reduce((sum, line) => {
    if (line.vat_treatment === 'domestic_deductible' || line.vat_treatment === 'non_deductible') {
      return sum + parseAmount(line.gross_amount);
    }
    return sum + parseAmount(line.net_amount);
  }, 0));

  return {
    paymentAccountAmountSek,
    deductibleInputVatSek,
    reverseChargeBaseSek,
    reverseChargeOutputVatSek,
    reverseChargeInputVatSek,
    nonDeductibleVatIncludedSek,
    totalGrossSek: snapshot.convertedGrossSek,
    totalOriginalGross: snapshot.originalGross,
    totalOriginalNet: snapshot.originalNet,
    totalOriginalVat: snapshot.originalVat,
    originalCurrency: snapshot.originalCurrency,
  };
}

export function derivePaymentAccountOriginalAmount(
  vatTreatment: VatTreatment,
  snapshot: PurchaseExchangeSnapshot,
): number {
  if (vatTreatment === 'reverse_charge' || vatTreatment === 'no_vat') {
    return snapshot.originalNet;
  }
  return snapshot.originalGross;
}

export function detectForeignCurrencyIntegrityIssue(
  purchase: PurchaseLike,
  expected: PurchaseExchangeSnapshot,
): DetectedCurrencyIntegrityIssue | null {
  const stored = getPurchaseExchangeSnapshot(purchase);
  if (!isForeignCurrency(stored.originalCurrency)) return null;

  const issues: string[] = [];
  const storedRate = stored.exchangeRate;

  if (!stored.exchangeRateDate || !storedRate || stored.exchangeRateSource === 'LEGACY_UNCONVERTED') {
    issues.push('Missing persisted ECB conversion snapshot');
  }

  const storedLooksUnconverted = nearlyEqual(stored.convertedGrossSek, stored.originalGross)
    && !nearlyEqual(expected.convertedGrossSek, stored.originalGross);
  if (storedLooksUnconverted) {
    issues.push('Stored SEK amount still matches the original foreign amount');
  }

  if (!nearlyEqual(stored.convertedGrossSek, expected.convertedGrossSek)
    || !nearlyEqual(stored.convertedNetSek, expected.convertedNetSek)
    || !nearlyEqual(stored.convertedVatSek, expected.convertedVatSek)) {
    issues.push('Stored SEK amounts differ from the persisted invoice-date ECB conversion');
  }

  if (issues.length === 0) return null;

  return {
    reason: issues.join('. '),
    stored,
    expected,
    status: purchase.status === 'posted' ? 'posted_requires_backfill' : 'draft_requires_backfill',
  };
}

export function nearlyEqual(a: number, b: number, tolerance = 0.01): boolean {
  return Math.abs(roundMoney(a) - roundMoney(b)) <= tolerance;
}

export function describeJournalOriginalAmount(
  kind: 'expense' | 'input_vat' | 'reverse_charge_vat' | 'payment',
  vatTreatment: VatTreatment,
  snapshot: PurchaseExchangeSnapshot,
): number | null {
  if (snapshot.originalCurrency === BASE_CURRENCY) {
    if (kind === 'expense') {
      return vatTreatment === 'non_deductible' ? snapshot.originalGross : snapshot.originalNet;
    }
    if (kind === 'input_vat') return snapshot.originalVat;
    if (kind === 'reverse_charge_vat') return null;
    return derivePaymentAccountOriginalAmount(vatTreatment, snapshot);
  }

  if (kind === 'expense') {
    return vatTreatment === 'non_deductible' ? snapshot.originalGross : snapshot.originalNet;
  }
  if (kind === 'input_vat') return snapshot.originalVat;
  if (kind === 'reverse_charge_vat') return null;
  return derivePaymentAccountOriginalAmount(vatTreatment, snapshot);
}
