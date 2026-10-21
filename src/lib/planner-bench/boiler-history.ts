// Repair meter ownership in captured cases without changing their electrical demand.
import { BOILER_PHASE_METERS, HOUSEHOLD } from './household';
import { QUARTERS, QUARTER_MS, type BenchRecorded, type BenchScenarioData, type Series } from './case';
import { localDay } from '../../../supabase/functions/_shared/planner-wasm/calendar';

export interface MeterStatistics {
  entities: { entity_id: string; statistics: { start: number; change: number | null }[] }[];
}
const MIXED_METER = 'sensor.hot_water_energy';
const PREHEAT_METER = 'sensor.heat_pump_hot_water_energy';
const HOUR_MS = 3_600_000;

/** The measured component shares identify the old mixed forecast and readings.
 * They do not introduce future house demand into the captured forecast. Hourly
 * statistics cannot recover the thermostat's individual quarter-hour cycles. */
export function separateBoilerHistory(dataset: BenchScenarioData, recorded: BenchRecorded, statistics: MeterStatistics): {
  dataset: BenchScenarioData; recorded: BenchRecorded;
} {
  const boilerKey = HOUSEHOLD.hot_water.meter_keys[0];
  if (dataset.other_devices_w[boilerKey] || recorded.actual?.other_devices_w?.[boilerKey]) {
    throw new Error('This case already identifies the boiler separately.');
  }
  if (!recorded.actual) throw new Error('Measured house consumption is required.');
  const meters = new Map(statistics.entities.map(entity => [entity.entity_id,
    new Map(entity.statistics.map(row => [row.start, row.change]))]));
  const energy = (key: string, hour: number): number => {
    const value = meters.get(key)?.get(hour);
    if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) {
      throw new Error(`Missing consumption statistics for ${key} at ${new Date(hour).toISOString()}.`);
    }
    return value;
  };
  const fractions = Array.from({ length: QUARTERS }, (_, i) => {
    const hour = Math.floor((Date.parse(dataset.start) + i * QUARTER_MS) / HOUR_MS) * HOUR_MS;
    const boiler = BOILER_PHASE_METERS.reduce((sum, key) => sum + energy(key, hour), 0);
    const mixed = energy(MIXED_METER, hour);
    // Both components are consumption: counter precision cannot create a
    // negative preheat portion or give the boiler more than the mixed reading.
    const preheat = Math.max(0, mixed - boiler);
    return boiler + preheat > 0 ? boiler / (boiler + preheat) : 0;
  });
  const separate = (series: Record<string, Series> | undefined): Record<string, Series> => {
    const mixed = series?.[MIXED_METER];
    if (!mixed || mixed.length !== QUARTERS) throw new Error('The captured mixed hot-water series is missing.');
    const boiler = mixed.map((watts, i) => watts * fractions[i]);
    // Retain the original aggregate as source evidence. The planner takes out
    // only boilerKey from the already inclusive base load, exactly once.
    return { ...series, [boilerKey]: boiler, [PREHEAT_METER]: mixed.map((watts, i) => watts - boiler[i]) };
  };
  return {
    dataset: { ...dataset, other_devices_w: separate(dataset.other_devices_w), origin: { ...dataset.origin,
      detail: `${dataset.origin.detail}\nBoiler/preheat attribution reconstructed from sample-period hourly phase and mixed-meter statistics; original aggregate forecast and house demand preserved.` } },
    recorded: { ...recorded, actual: { ...recorded.actual, other_devices_w: separate(recorded.actual.other_devices_w) } },
  };
}

/** The first local day the heat pump made the hot water: the boiler's daily
 * electricity halved from here (29 August 2026). */
export const CURRENT_HOT_WATER_FROM = '2026-08-29';
/** User decision, 21 October 2026: cases from before then are scaled to the
 * current house by one ratio, all of it kept as boiler. Median daily hot water
 * 9 September–14 October 2026, boiler and heat pump (3.815 kWh), over the
 * median daily boiler 1 May–28 August 2026 (5.037 kWh). */
export const OLD_HOUSE_HOT_WATER_RATIO = 0.7575;
const SCALED_NOTE = 'Hot water before 2026-08-29 scaled';

/** Scale the boiler's quarters on local days before `from` by `ratio`, in the
 * forecast and the measurement alike. Base load and the mixed hot-water meter
 * include the boiler, so each loses exactly the energy the boiler loses; the
 * rest of the house is unchanged. A case is scaled once. */
export function scaleOldHouseHotWater(dataset: BenchScenarioData, recorded: BenchRecorded,
  ratio = OLD_HOUSE_HOT_WATER_RATIO, from = CURRENT_HOT_WATER_FROM): {
  dataset: BenchScenarioData; recorded: BenchRecorded; scaled_quarters: number; clipped_quarters: number;
} {
  if (dataset.origin.detail.includes(SCALED_NOTE)) throw new Error('This case\'s hot water is already scaled.');
  if (!(ratio > 0 && ratio <= 1)) throw new Error('The hot-water ratio must be in (0, 1].');
  const boilerKey = HOUSEHOLD.hot_water.meter_keys[0];
  const old = Array.from({ length: QUARTERS }, (_, i) =>
    localDay(new Date(Date.parse(dataset.start) + i * QUARTER_MS).toISOString(), dataset.timezone) < from);
  const scale = (base: Series, devices: Record<string, Series> | undefined, label: string) => {
    const boiler = devices?.[boilerKey];
    if (!boiler || boiler.length !== QUARTERS) throw new Error(`${label}: the boiler series is missing; separate it first.`);
    const removed = boiler.map((watts, i) => old[i] ? watts * (1 - ratio) : 0);
    const less = (series: Series) => series.map((watts, i) => watts - removed[i]);
    const mixed = devices![MIXED_METER];
    // Where the captured base load is already below the boiler reading, the
    // planner clips the rest of the house to zero either way.
    clipped += less(base).filter(watts => watts < 0).length;
    return { base: less(base).map(watts => Math.max(0, watts)),
      devices: { ...devices, [boilerKey]: less(boiler), ...(mixed ? { [MIXED_METER]: less(mixed).map(watts => Math.max(0, watts)) } : {}) } };
  };
  let clipped = 0;
  const told = scale(dataset.base_load_forecast_w, dataset.other_devices_w, 'forecast');
  const measured = recorded.actual ? scale(recorded.actual.base_load_w, recorded.actual.other_devices_w, 'measurement') : null;
  return {
    dataset: { ...dataset, base_load_forecast_w: told.base, other_devices_w: told.devices, origin: { ...dataset.origin,
      detail: `${dataset.origin.detail}\n${SCALED_NOTE} by ${ratio} to the current house (heat pump hot water from ${from}); boiler only, base load reduced by the same energy.` } },
    recorded: measured ? { ...recorded, actual: { ...recorded.actual!, base_load_w: measured.base, other_devices_w: measured.devices } } : recorded,
    scaled_quarters: old.filter(Boolean).length, clipped_quarters: clipped,
  };
}
