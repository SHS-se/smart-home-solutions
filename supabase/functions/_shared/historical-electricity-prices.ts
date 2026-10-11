import { currentGridPrices, type GridTariffCatalogue } from './energy-grid-pricing.ts';
import { calculateSupplierPrice, parseSpotPriceIntervals } from './energy-supplier-pricing.ts';
import { localDay } from './planner-wasm/calendar.ts';

export interface HistoricalPrice {
  start_ts: string; import_price_sek_per_kwh: number; export_price_sek_per_kwh: number;
  grid_import_price_sek_per_kwh: number; source: 'archive' | 'reconstructed'; supplier_revision: string;
}
export interface SupplierVersion { revision: string; valid_from: string; valid_to: string | null; definition: unknown }
export interface ArchivedPrice { start_ts: string; import_price_sek_per_kwh: number; export_price_sek_per_kwh: number }
const QUARTER = 900_000;

/** A bounded historical read, independent of the legacy relative-day backfill writer. */
export function historicalPriceRange(start: unknown, end: unknown) {
  const from = typeof start === 'string' ? Date.parse(start) : NaN;
  const to = typeof end === 'string' ? Date.parse(end) : NaN;
  if (!Number.isFinite(from) || !Number.isFinite(to) || from % QUARTER || to % QUARTER || to <= from || to - from > 32 * 86_400_000) {
    throw new Error('Invalid historical price period (maximum 32 days)');
  }
  return Array.from({ length: (to - from) / QUARTER }, (_, i) => new Date(from + i * QUARTER).toISOString());
}

/** Archive totals win. Only holes fetch real market data; nothing is persisted. */
export async function historicalElectricityPrices(starts: string[], archive: ArchivedPrice[], catalogue: GridTariffCatalogue,
  supplierVersions: SupplierVersion[], fetchDay: (day: string) => Promise<unknown>): Promise<HistoricalPrice[]> {
  const archived = new Map(archive.map(row => [Date.parse(row.start_ts), row]));
  if (archived.size !== archive.length) throw new Error('Duplicate archived electricity price');
  const zone = catalogue.timezone!;
  const missingDays = [...new Set(starts.filter(at => !archived.has(Date.parse(at))).map(at => localDay(at, zone)))];
  const market = new Map<number, ReturnType<typeof parseSpotPriceIntervals>[number]>();
  for (let i = 0; i < missingDays.length; i += 8) {
    const days = await Promise.all(missingDays.slice(i, i + 8).map(async day => parseSpotPriceIntervals(await fetchDay(day))));
    days.flat().forEach(interval => market.set(Date.parse(interval.time_start), interval));
  }
  return starts.map(at => {
    const grid = currentGridPrices(catalogue, new Date(at));
    if (!grid) throw new Error(`Missing grid tariff at ${at}`);
    const prior = archived.get(Date.parse(at));
    if (prior) {
      if (![prior.import_price_sek_per_kwh, prior.export_price_sek_per_kwh].every(Number.isFinite)) throw new Error(`Invalid archived electricity price at ${at}`);
      return { ...prior, start_ts: at, grid_import_price_sek_per_kwh: grid.import_price_sek_per_kwh, source: 'archive', supplier_revision: '' };
    }
    const day = localDay(at, zone), version = supplierVersions.find(v => v.valid_from <= day && (!v.valid_to || v.valid_to >= day));
    if (!version) throw new Error(`Missing supplier terms for ${day}`);
    const interval = market.get(Date.parse(at));
    if (!interval) throw new Error(`Missing historical market price at ${at}`);
    const supplier = calculateSupplierPrice(interval, version.definition);
    const round = (v: number) => Math.round(v * 100_000) / 100_000;
    return { start_ts: at, import_price_sek_per_kwh: round(supplier.supplier_import_price_sek_per_kwh + grid.import_price_sek_per_kwh),
      export_price_sek_per_kwh: round(supplier.supplier_export_price_sek_per_kwh + grid.export_price_sek_per_kwh),
      grid_import_price_sek_per_kwh: grid.import_price_sek_per_kwh, source: 'reconstructed', supplier_revision: version.revision };
  });
}
