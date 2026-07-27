import { supabase } from '@/integrations/supabase/client';
import type { Json, Tables } from '@/integrations/supabase/types';
import type {
  EnergyChargeCategory,
  ParsedEnergyDocument,
} from '@/lib/energy-billing-parser';
import type { EnergyBillingDocumentForSeries } from '@/lib/energy-billing-series';

export const ENERGY_BILLING_BUCKET = 'energy-billing-documents';
export const MAX_ENERGY_BILL_FILE_BYTES = 15 * 1024 * 1024;

type EnergyBillingDocumentRow = Tables<'energy_billing_documents'>;
type EnergyBillingLineItemRow = Tables<'energy_billing_line_items'>;

export interface EnergyBillingDocumentRecord extends EnergyBillingDocumentRow {
  lineItems: EnergyBillingLineItemRow[];
}

export class EnergyBillingImportError extends Error {
  constructor(
    public readonly code: 'duplicate' | 'upload_failed' | 'save_failed',
    message: string,
  ) {
    super(message);
    this.name = 'EnergyBillingImportError';
  }
}

function normalizeFileName(fileName: string): string {
  const normalized = fileName
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-zA-Z0-9._-]+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '');
  return normalized || 'energy-invoice';
}

function bytesToHex(bytes: Uint8Array): string {
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('');
}

export async function sha256File(file: File): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', await file.arrayBuffer());
  return bytesToHex(new Uint8Array(digest));
}

function resolvedMimeType(file: File): string {
  if (file.type) return file.type;
  const extension = file.name.toLocaleLowerCase().split('.').at(-1);
  const inferredTypes: Record<string, string> = {
    pdf: 'application/pdf',
    jpg: 'image/jpeg',
    jpeg: 'image/jpeg',
    png: 'image/png',
    webp: 'image/webp',
    heic: 'image/heic',
    heif: 'image/heif',
  };
  return inferredTypes[extension ?? ''] ?? 'application/octet-stream';
}

export async function fetchEnergyBillingDocuments(
  customerId: string,
): Promise<EnergyBillingDocumentRecord[]> {
  const { data, error } = await supabase
    .from('energy_billing_documents')
    .select('*, energy_billing_line_items(*)')
    .eq('customer_id', customerId)
    .order('period_start', { ascending: true })
    .order('created_at', { ascending: true });

  if (error) throw error;

  return (data ?? []).map((document) => ({
    ...document,
    lineItems: [...(document.energy_billing_line_items ?? [])].sort(
      (a, b) => a.sort_order - b.sort_order,
    ),
  }));
}

export function toEnergyBillingSeriesDocuments(
  records: EnergyBillingDocumentRecord[],
): EnergyBillingDocumentForSeries[] {
  return records.map((record) => ({
    id: record.id,
    documentKind: record.document_kind === 'grid' ? 'grid' : 'electricity',
    periodStart: record.period_start,
    periodEnd: record.period_end,
    consumptionKwh: record.consumption_kwh,
    exportedKwh: record.exported_kwh,
    peakDemandKw: record.peak_demand_kw,
    totalAmountSek: record.total_amount_sek,
    lineItems: record.lineItems.map((lineItem) => ({
      category: lineItem.category as EnergyChargeCategory,
      amountSek: lineItem.amount_sek,
      periodStart: lineItem.period_start,
      periodEnd: lineItem.period_end,
    })),
  }));
}

export async function storeEnergyBillingDocument(params: {
  customerId: string;
  file: File;
  parsed: ParsedEnergyDocument;
  documentSha256: string;
}): Promise<string> {
  const { customerId, file, parsed, documentSha256 } = params;
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
    throw new EnergyBillingImportError('save_failed', 'Parser result is not importable');
  }

  const { data: duplicate, error: duplicateError } = await supabase
    .from('energy_billing_documents')
    .select('id')
    .eq('customer_id', customerId)
    .eq('document_sha256', documentSha256)
    .maybeSingle();
  if (duplicateError) {
    throw new EnergyBillingImportError('save_failed', duplicateError.message);
  }
  if (duplicate) {
    throw new EnergyBillingImportError('duplicate', 'Document has already been imported');
  }

  const storagePath = `${customerId}/${crypto.randomUUID()}/${normalizeFileName(file.name)}`;
  const mimeType = resolvedMimeType(file);
  const { error: uploadError } = await supabase.storage
    .from(ENERGY_BILLING_BUCKET)
    .upload(storagePath, file, {
      contentType: mimeType,
      upsert: false,
    });
  if (uploadError) {
    throw new EnergyBillingImportError('upload_failed', uploadError.message);
  }

  const documentPayload = {
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
    file_path: storagePath,
    original_file_name: file.name,
    mime_type: mimeType,
    file_size_bytes: file.size,
    document_sha256: documentSha256,
  } satisfies Json;

  const lineItemPayload = parsed.lineItems.map((lineItem) => ({
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

  const { data: documentId, error: saveError } = await supabase.rpc(
    'create_energy_billing_document',
    {
      p_customer_id: customerId,
      p_document: documentPayload,
      p_line_items: lineItemPayload,
    },
  );

  if (saveError || !documentId) {
    const { error: cleanupError } = await supabase.storage
      .from(ENERGY_BILLING_BUCKET)
      .remove([storagePath]);
    if (cleanupError) {
      console.error('Failed to clean up energy invoice after database error:', cleanupError);
    }
    const code = saveError?.code === '23505' ? 'duplicate' : 'save_failed';
    throw new EnergyBillingImportError(code, saveError?.message || 'Document was not saved');
  }

  return documentId;
}
