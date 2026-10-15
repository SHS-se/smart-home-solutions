// Repair meter ownership in captured cases without changing their electrical demand.
import { BOILER_PHASE_METERS, HOUSEHOLD } from './household';
import { QUARTERS, QUARTER_MS, type BenchRecorded, type BenchScenarioData, type Series } from './case';

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
