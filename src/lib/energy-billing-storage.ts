import { supabase } from '@/integrations/supabase/client';
import type { Json, Tables } from '@/integrations/supabase/types';
import type {
  EnergyChargeCategory,
  ParsedEnergyDocument,
} from '@/lib/energy-billing-parser';
import type { EnergyBillingDocumentForSeries } from '@/lib/energy-billing-series';
import { resolvedEnergyFileMimeType } from '@/lib/energy-import-file-storage';
import { fetchAllRows } from '@/lib/fetch-all-rows';

export const ENERGY_BILLING_BUCKET = 'energy-billing-documents';

type EnergyBillingDocumentRow = Tables<'energy_billing_documents'>;
type EnergyBillingLineItemRow = Tables<'energy_billing_line_items'>;

export interface EnergyBillingDocumentRecord extends EnergyBillingDocumentRow {
  lineItems: EnergyBillingLineItemRow[];
}

interface LegacyEnergyBillingSourceRow {
  customer_id: string;
  file_path: string | null;
  id: string;
}

interface LegacyEnergyBillingSource extends LegacyEnergyBillingSourceRow {
  file_path: string;
}

export class EnergyBillingImportError extends Error {
  constructor(
    public readonly code: 'duplicate' | 'save_failed',
    message: string,
  ) {
    super(message);
    this.name = 'EnergyBillingImportError';
  }
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

  const records = (data ?? []).map((document) => ({
    ...document,
    lineItems: [...(document.energy_billing_line_items ?? [])].sort(
      (a, b) => a.sort_order - b.sort_order,
    ),
  }));
  await purgeLegacyEnergyBillingSourceFiles(records);
  return records.map((record) => (
    record.file_path === null ? record : { ...record, file_path: null }
  ));
}

async function purgeLegacyEnergyBillingSourceFiles(
  records: LegacyEnergyBillingSourceRow[],
): Promise<number> {
  const recordsWithFiles = records.filter(
    (record): record is LegacyEnergyBillingSource => (
      typeof record.file_path === 'string' && record.file_path.length > 0
    ),
  );
  if (recordsWithFiles.length === 0) return 0;

  const customerIds = [...new Set(recordsWithFiles.map((record) => record.customer_id))];
  for (const customerId of customerIds) {
    const customerRecords = recordsWithFiles.filter(
      (record) => record.customer_id === customerId,
    );
    for (let index = 0; index < customerRecords.length; index += 100) {
      const batch = customerRecords.slice(index, index + 100);
      const { error: storageError } = await supabase.storage
        .from(ENERGY_BILLING_BUCKET)
        .remove(batch.map((record) => record.file_path));
      if (storageError) {
        throw new Error(`A legacy energy source file could not be removed: ${storageError.message}`);
      }

      const { error: clearError } = await supabase.rpc('clear_energy_billing_file_paths', {
        p_customer_id: customerId,
        p_document_ids: batch.map((record) => record.id),
      });
      if (clearError) {
        throw new Error(`Legacy energy file metadata could not be cleared: ${clearError.message}`);
      }
    }
  }

  return recordsWithFiles.length;
}

export async function purgeAllLegacyEnergyBillingSourceFilesForStaff(): Promise<number> {
  const records = await fetchAllRows<LegacyEnergyBillingSourceRow>((from, to) => supabase
    .from('energy_billing_documents')
    .select('id, customer_id, file_path')
    .not('file_path', 'is', null)
    .order('customer_id', { ascending: true })
    .order('id', { ascending: true })
    .range(from, to));
  return purgeLegacyEnergyBillingSourceFiles(records);
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
      quantity: lineItem.quantity,
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
    original_file_name: file.name,
    mime_type: resolvedEnergyFileMimeType(file),
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
    const code = saveError?.code === '23505' ? 'duplicate' : 'save_failed';
    throw new EnergyBillingImportError(code, saveError?.message || 'Document was not saved');
  }

  return documentId;
}

export async function deleteEnergyBillingDocument(
  customerId: string,
  document: EnergyBillingDocumentRecord,
): Promise<void> {
  if (document.customer_id !== customerId) {
    throw new Error('The invoice does not belong to this customer.');
  }

  if (document.file_path) {
    const { error: storageError } = await supabase.storage
      .from(ENERGY_BILLING_BUCKET)
      .remove([document.file_path]);
    if (storageError) throw storageError;
  }

  const { error } = await supabase.rpc('delete_energy_billing_document', {
    p_customer_id: customerId,
    p_document_id: document.id,
  });
  if (error) throw error;
}
