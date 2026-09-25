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

export async function fetchRoiMonthlyPrices(area: string, months: string[]): Promise<Record<string, number>> {
  const prices: Record<string, number> = {};
  // Keep cold-cache upstream traffic bounded across month requests.
  for (const month of months) {
    const { data, error } = await supabase.functions.invoke('roi-monthly-prices', { body: { area, month } });
    if (error) throw error;
    if (typeof data?.average_sek_ex_vat !== 'number' || !Number.isFinite(data.average_sek_ex_vat)) throw new Error('Monthly price unavailable');
    prices[month] = data.average_sek_ex_vat * 1.25 * 100;
  }
  return prices;
}
