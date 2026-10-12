import { localDay } from './planner-wasm/calendar.ts';
import type { HistoricalPrice, ArchivedPrice } from './historical-electricity-prices.ts';

export interface InvoicePriceLine {
  category: string; label: string; unit: string | null; unit_price_sek: number | null;
  amount_includes_vat: boolean; period_start: string | null; period_end: string | null;
}
export interface PriceInvoice {
  id: string; provider_key: string; parser_id: string; document_kind: string; period_start: string; period_end: string;
  energy_billing_line_items: InvoicePriceLine[];
}
export interface ActualPrice {
  start_ts: string; import_price_sek_per_kwh: number | null; export_price_sek_per_kwh: number | null;
  source: 'invoice' | 'archive' | 'unavailable';
}
const monthly = new Set(['karlstads_energi_microproduction', 'karlstads_energi_detailed', 'karlstads_energi_consolidated']);
const gridShapes = new Set(['ellevio_flat_transfer', 'ellevio_peak_demand']);
const covers = (document: PriceInvoice, day: string) => document.period_start <= day && document.period_end >= day;

function rates(document: PriceInvoice, day: string, categories: readonly string[], vat: boolean): number | null {
  const lines = document.energy_billing_line_items.filter(line => categories.includes(line.category) && line.unit?.toLowerCase() === 'kwh'
    && (line.period_start ?? document.period_start) <= day && (line.period_end ?? document.period_end) >= day);
  if (!lines.length || new Set(lines.map(line => `${line.category}:${line.label.toLowerCase()}`)).size !== lines.length) return null;
  if (lines.some(line => line.unit_price_sek === null || !Number.isFinite(line.unit_price_sek))) return null;
  return lines.reduce((sum, line) => sum + line.unit_price_sek! * (vat && !line.amount_includes_vat ? 1.25 : 1), 0);
}
/** Invoice contract terms override configured archive charges. Unbilled live quarters retain their own receipts.
 * Fixed fees and demand charges belong exclusively to the complete invoice total, not a marginal kWh price. */
export function actualContractPrices(prices: readonly HistoricalPrice[], invoices: readonly PriceInvoice[], archive: readonly (ArchivedPrice & { source: string })[], timeZone: string): ActualPrice[] {
  const receipts = new Map(archive.filter(row => row.source !== 'portal_backfill').map(row => [Date.parse(row.start_ts), row]));
  const days = new Map<string, { supplier: PriceInvoice | null; grid: PriceInvoice | null; ambiguous: boolean }>();
  return prices.map(price => {
    const day = localDay(price.start_ts, timeZone);
    if (!days.has(day)) {
      const suppliers = invoices.filter(invoice => invoice.document_kind === 'electricity' && covers(invoice, day));
      const grids = invoices.filter(invoice => invoice.document_kind === 'grid' && covers(invoice, day));
      days.set(day, { supplier: suppliers.length === 1 ? suppliers[0] : null, grid: grids.length === 1 ? grids[0] : null, ambiguous: suppliers.length > 1 || grids.length > 1 });
    }
    const { supplier, grid, ambiguous } = days.get(day)!;
    if (!supplier && !grid && !ambiguous) {
      const receipt = receipts.get(Date.parse(price.start_ts));
      if (receipt && [receipt.import_price_sek_per_kwh, receipt.export_price_sek_per_kwh].every(Number.isFinite)) return { ...receipt, source: 'archive' as const };
    }
    const unknown: ActualPrice = { start_ts: price.start_ts, import_price_sek_per_kwh: null, export_price_sek_per_kwh: null, source: 'unavailable' };
    if (ambiguous || !supplier || !grid || !gridShapes.has(grid.parser_id)) return unknown;
    const gridImport = rates(grid, day, ['energy_transfer', 'energy_tax'], true);
    if (gridImport === null || !['energy_transfer', 'energy_tax'].every(category => rates(grid, day, [category], true) !== null)) return unknown;
    let importPrice: number | null = null, exportPrice: number | null = null;
    if (monthly.has(supplier.parser_id)) {
      const energy = rates(supplier, day, ['spot_energy'], true);
      const adders = rates(supplier, day, ['variable_fee', 'markup'], true);
      if (energy !== null && adders !== null && ['variable_fee', 'markup'].every(category => rates(supplier, day, [category], true) !== null)) importPrice = energy + adders + gridImport;
      // Karlstads microproduction is settled against time-varying market spot,
      // independently of the monthly import contract.
      const productionFee = rates(supplier, day, ['export_fee'], false);
      if (productionFee !== null && price.spot_price_sek_per_kwh !== null) exportPrice = price.spot_price_sek_per_kwh - productionFee;
    } else if (supplier.parser_id === 'tibber_quarterly') {
      const adders = rates(supplier, day, ['variable_fee', 'markup'], true);
      const vatConfirmed = supplier.energy_billing_line_items.some(line => line.category === 'vat' && /25/.test(line.label));
      if (vatConfirmed && adders !== null && ['variable_fee', 'markup'].every(category => rates(supplier, day, [category], true) !== null) && price.spot_price_sek_per_kwh !== null) {
        importPrice = price.spot_price_sek_per_kwh * 1.25 + adders + gridImport;
        exportPrice = price.spot_price_sek_per_kwh;
      }
    }
    const gridCredit = rates(grid, day, ['export_credit'], false);
    if (exportPrice !== null) {
      if (gridCredit === null) exportPrice = null;
      else exportPrice -= gridCredit;
    }
    return { start_ts: price.start_ts, import_price_sek_per_kwh: importPrice, export_price_sek_per_kwh: exportPrice, source: importPrice === null ? 'unavailable' : 'invoice' };
  });
}
