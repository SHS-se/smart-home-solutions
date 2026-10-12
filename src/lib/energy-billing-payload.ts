import type { Json } from '../integrations/supabase/types.ts';
import type { ParsedEnergyDocument } from './energy-billing-parser.ts';

export interface EnergySourceMetadata {
  fileName: string;
  mimeType: string;
  sizeBytes: number;
  sha256: string;
}

export function createEnergyBillingPayload(parsed: ParsedEnergyDocument, source: EnergySourceMetadata) {
  if (
    !parsed.importable
    || !parsed.documentKind
    || !parsed.providerKey
    || !parsed.providerName
    || !parsed.parserId
    || !parsed.parserVersion
    || !parsed.invoiceNumber
    || !parsed.invoiceDate
    || !parsed.periodStart
    || !parsed.periodEnd
    || parsed.consumptionKwh === null
    || parsed.totalAmountSek === null
  ) {
    throw new Error('Parser result is not importable');
  }

  const document = {
    document_kind: parsed.documentKind,
    provider_key: parsed.providerKey,
    provider_name: parsed.providerName,
    parser_id: parsed.parserId,
    parser_version: parsed.parserVersion,
    invoice_number: parsed.invoiceNumber,
    invoice_date: parsed.invoiceDate,
    period_start: parsed.periodStart,
    period_end: parsed.periodEnd,
    consumption_kwh: parsed.consumptionKwh,
    exported_kwh: parsed.exportedKwh,
    peak_demand_kw: parsed.peakDemandKw,
    vat_sek: parsed.vatSek,
    total_amount_sek: parsed.totalAmountSek,
    currency: parsed.currency,
    original_file_name: source.fileName,
    mime_type: source.mimeType,
    file_size_bytes: source.sizeBytes,
    document_sha256: source.sha256,
  } satisfies Json;

  const lineItems = parsed.lineItems.map((lineItem) => ({
    category: lineItem.category,
    label: lineItem.label,
    amount_sek: lineItem.amountSek,
    quantity: lineItem.quantity,
    unit: lineItem.unit,
    unit_price_sek: lineItem.unitPriceSek,
    period_start: lineItem.periodStart,
    period_end: lineItem.periodEnd,
    amount_includes_vat: lineItem.amountIncludesVat,
  })) satisfies Json[];

  return { document, lineItems };
}

export type EnergyBillingPayload = ReturnType<typeof createEnergyBillingPayload>;
