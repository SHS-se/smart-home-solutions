import { localMoment, resolveTariff, type GridTariffCatalogue } from '../../../supabase/functions/_shared/energy-grid-pricing.ts';
import { homeMonthBounds } from '../energy-shift/home-time.ts';
import { ROI_SUPPLIER_TERMS } from '../../../supabase/functions/_shared/roi-supplier-terms.ts';
import type { ElectricityLedger } from './ledger.ts';

export interface BillExtras { supplierFixedSek: number; gridFixedSek: number; gridPeakSek: number; peakKw: number; totalSek: number }
const object = (v: unknown): Record<string, unknown> => { if (!v || typeof v !== 'object' || Array.isArray(v)) throw new Error('Missing monthly grid tariff definition'); return v as Record<string, unknown>; };
const number = (v: unknown) => { if (typeof v !== 'number' || !Number.isFinite(v)) throw new Error('Invalid monthly grid tariff amount'); return v; };

/** Port of HA tariff.py fixed/peak rules. Per-kWh charges already exist in the ledger. */
export function scenarioBill(ledger: ElectricityLedger, start: string, end: string, timeZone: string, importW: readonly number[], catalogue: GridTariffCatalogue): BillExtras {
  const configuration = catalogue.configuration;
  if (!configuration) throw new Error('Monthly grid tariff configuration unavailable');
  if (importW.length * 900_000 !== Date.parse(end) - Date.parse(start)) throw new Error('Bill flow length does not match period');
  let coverage = 0;
  const hours = new Map<number, number>();
  importW.forEach((w, i) => { const at = Date.parse(start) + i * 900_000, hour = Math.floor(at / 3_600_000) * 3_600_000; hours.set(hour, (hours.get(hour) ?? 0) + w / 4000); });
  const groups = new Map<string, { definition: Record<string, unknown>; hours: { at: number; kwh: number }[]; count: number; monthMs: number }>();
  for (let i = 0; i < importW.length; i++) {
    const at = Date.parse(start) + i * 900_000, local = localMoment(new Date(at), catalogue.timezone ?? timeZone);
    const date = `${local.year}-${String(local.month).padStart(2, '0')}-${String(local.day).padStart(2, '0')}`;
    const tariff = resolveTariff(catalogue, date); if (!tariff) throw new Error(`Missing monthly grid tariff at ${date}`);
    const key = `${local.year}-${local.month}:${tariff.revision}`;
    if (!groups.has(key)) { const bounds = homeMonthBounds(new Date(at).toISOString(), 0, timeZone); groups.set(key, { definition: tariff.definition, hours: [], count: 0, monthMs: bounds.endMs - bounds.startMs }); }
    const group = groups.get(key)!; coverage += 900_000 / group.monthMs; group.count++;
    if (i === 0 || at % 3_600_000 === 0) group.hours.push({ at: Math.floor(at / 3_600_000) * 3_600_000, kwh: hours.get(Math.floor(at / 3_600_000) * 3_600_000)! });
  }
  let gridFixedSek = 0, gridPeakSek = 0, peakKw = 0;
  for (const group of groups.values()) {
    const plan = object(object(group.definition.plans)[configuration.connection_type]);
    const selector = String(configuration[plan.selector as 'fuse_a' | 'apartment_band']);
    const vat = configuration.include_vat ? 1 + number(group.definition.vat_rate) : 1;
    gridFixedSek += number(object(plan.fixed_monthly_sek_ex_vat)[selector]) * vat * group.count * 900_000 / group.monthMs;
    if (plan.demand == null) continue;
    const demand = object(plan.demand), topN = number(demand.top_n), nightStart = number(demand.night_start_hour), nightEnd = number(demand.night_end_hour), factor = number(demand.night_factor);
    if (!Number.isInteger(topN) || topN < 1 || typeof demand.distinct_local_days !== 'boolean' || !Number.isInteger(nightStart) || nightStart < 0 || nightStart > 23 || !Number.isInteger(nightEnd) || nightEnd < 0 || nightEnd > 23 || factor < 0 || factor > 1) throw new Error('Invalid grid peak tariff rule');
    const daily = new Map<string, number>(), values: number[] = [];
    for (const h of group.hours) {
      const local = localMoment(new Date(h.at), catalogue.timezone ?? timeZone);
      const night = nightStart === nightEnd ? false : nightStart < nightEnd ? local.hour >= nightStart && local.hour < nightEnd : local.hour >= nightStart || local.hour < nightEnd;
      const value = h.kwh * (night ? factor : 1), day = `${local.year}-${local.month}-${local.day}`;
      daily.set(day, Math.max(daily.get(day) ?? 0, value)); values.push(value);
    }
    const peaks = (demand.distinct_local_days ? [...daily.values()] : values).sort((a, b) => b - a).slice(0, topN);
    const quantity = peaks.length ? peaks.reduce((n, v) => n + v, 0) / peaks.length : 0;
    peakKw = Math.max(peakKw, quantity); gridPeakSek += quantity * number(demand.rate_sek_per_kw_ex_vat) * vat;
  }
  const supplierFixedSek = ROI_SUPPLIER_TERMS.definition.monthly_fee_sek_in_vat * coverage;
  return { supplierFixedSek, gridFixedSek, gridPeakSek, peakKw, totalSek: ledger.costSek + supplierFixedSek + gridFixedSek + gridPeakSek };
}
