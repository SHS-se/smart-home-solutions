import { supabase } from '@/integrations/supabase/client';
import { fetchAllRows } from '@/lib/fetch-all-rows';
import { toEnergyBillingSeriesDocuments, type EnergyBillingDocumentRecord } from '@/lib/energy-billing-storage';

/** Read-only, paginated invoice access for the ROI comparison. */
export async function fetchRoiInvoices(customerId: string) {
  const rows = await fetchAllRows((from, to) => supabase.from('energy_billing_documents')
    .select('*, energy_billing_line_items(*)')
    .eq('customer_id', customerId).eq('document_kind', 'electricity').eq('currency', 'SEK')
    .order('period_start').order('id').range(from, to));
  return toEnergyBillingSeriesDocuments(rows.map(row => ({ ...row, lineItems: row.energy_billing_line_items })) as EnergyBillingDocumentRecord[]);
}
