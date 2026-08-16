// Shared types and constants for the energy plan workspace.
//
// Split out of the former LoadShiftTab on 2026-08-13 so the plan's five
// sections can live in their own files (ENERGY_OPTIMISATION_ARCHITECTURE.md
// §1.3.5a). Nothing here changed in the move.

import type { PortalOptimisationPlan } from '@/lib/energy-shift/contracts';
import type { ThermalObservationSummary } from '@/lib/energy-shift/thermal-readiness';

export interface CurrentRow {
  plan: PortalOptimisationPlan;
  captured_at: string;
  updated_at: string;
}

// A refused fit is usually seasonal rather than faulty, so each reason gets

export const THERMAL_REJECTION_EN: Record<string, string> = {
  insufficient_samples: 'Not enough history yet. Observations are still accumulating.',
  insufficient_heating:
    'The heaters have not run enough for the model to learn how fast each room warms. This resolves once the heating season starts; nothing needs changing.',
  singular: 'The observations so far cannot separate heating from heat loss.',
  poor_fit: 'The fitted model did not explain the measured temperatures well enough to publish.',
  non_physical: 'The fit produced a physically impossible result and was refused.',
  sensor_tracks_outdoor:
    'A zone temperature sensor follows outdoor air too closely to be measuring a room. Check the room sensor mapping.',
};

export const THERMAL_REJECTION_SV: Record<string, string> = {
  insufficient_samples: 'Ännu inte tillräckligt med historik. Observationer samlas fortfarande in.',
  insufficient_heating:
    'Värmeenheterna har inte gått tillräckligt för att modellen ska lära sig hur snabbt rummen värms upp. Detta löser sig när uppvärmningssäsongen börjar; inget behöver ändras.',
  singular: 'Observationerna hittills kan inte skilja uppvärmning från värmeförlust.',
  poor_fit: 'Den anpassade modellen förklarade inte de uppmätta temperaturerna tillräckligt väl.',
  non_physical: 'Anpassningen gav ett fysiskt omöjligt resultat och avvisades.',
  sensor_tracks_outdoor:
    'En zongivare följer utomhusluften för nära för att mäta ett rum. Kontrollera mappningen av rumsgivaren.',
};

export const EMPTY_THERMAL_OBSERVATIONS: ThermalObservationSummary = {
  slotCount: 0,
  outdoorSlotCount: 0,
  observedRoomKeys: [],
  firstObservedAt: null,
  lastObservedAt: null,
};

export interface ZoneModelRow {
  room_key: string;
  trained: boolean;
  rejection_reason: string | null;
  sample_count: number;
}

export interface ThermalSlotRow {
  start_ts: string;
  outdoor_temperature_c: number | null;
  zone_observations: Record<string, unknown> | null;
}

/**
 * Reduce the stored thermal rows to the counts the readiness panel needs.
 * Rows are already one per quarter, so this stays cheap over a 30-day window.
 */
export const summariseThermalSlots = (
  rows: ThermalSlotRow[] | null,
): ThermalObservationSummary => {
  if (!rows || rows.length === 0) return EMPTY_THERMAL_OBSERVATIONS;
  const observedRoomKeys = new Set<string>();
  let outdoorSlotCount = 0;
  for (const row of rows) {
    if (row.outdoor_temperature_c !== null) outdoorSlotCount += 1;
    for (const key of Object.keys(row.zone_observations ?? {})) {
      observedRoomKeys.add(key);
    }
  }
  return {
    slotCount: rows.length,
    outdoorSlotCount,
    observedRoomKeys: [...observedRoomKeys],
    firstObservedAt: rows[0]?.start_ts ?? null,
    lastObservedAt: rows[rows.length - 1]?.start_ts ?? null,
  };
};

export interface EmpiricalDeviceSlotMatrix {
  start_ts: string;
  device_energy_kwh: Record<string, number>;
}

export interface HomeAssistantConnection {
  device_name: string;
  home_id: string;
  last_seen_at: string | null;
}


export const COLORS = {
  base: '#64748b',
  boiler: '#38bdf8',
  pool: '#14b8a6',
  ev: '#a78bfa',
  pv: '#f59e0b',
  soc: '#f43f5e',
  import: '#dc2626',
  export: '#0f766e',
  actual: '#111827',
  batteryCharge: '#2563eb',
  batteryDischarge: '#7c3aed',
  batteryExport: '#059669',
};

export type PlanViewMode = 'planned' | 'unplanned';
/**
 * The optimisation workspace uses top-level tabs. `plan` contains the headline
 * numbers and the live schedule; `history` owns measured performance and what
 * it cost; `devices` owns empirical Home Assistant models; the remaining
 * sections each own a focused chart.
 */
export type PlanSection = 'plan' | 'history' | 'devices' | 'thermal' | 'economics';

/**
 * How much of the window either chart draws. Both tabs fetch the full 72 hours
 * once and slice locally, so changing this never costs a round trip
 * (ENERGY_OPTIMISATION_ARCHITECTURE.md §1.3.7).
 */
export type WindowDays = 1 | 2 | 3;
export const WINDOW_DAY_OPTIONS: WindowDays[] = [1, 2, 3];
export const WINDOW_SLOTS_PER_DAY = 96;

export interface PriceSlotRow {
  start_ts: string;
  import_price_sek_per_kwh: number;
  export_price_sek_per_kwh: number;
}
export type PlanChartSeriesKey =
  | 'pv'
  | 'base'
  | 'boiler'
  | 'pool'
  | 'ev'
  | 'gridImport'
  | 'gridExport'
  | 'batteryChargePower'
  | `device:${string}`;
export type ThermalSeriesKey =
  | 'outdoor'
  | 'thermalPower'
  | `zoneTemperature:${string}`
  | `zoneTarget:${string}`;
export type EconomicsSeriesKey =
  | 'importPrice'
  | 'exportPrice'
  | 'plannedCost'
  | 'unplannedCost'
  | 'costDifference';
export type StorageSeriesKey =
  | 'homeSoc'
  | 'homeTarget'
  | 'homeCharge'
  | 'homeDischarge'
  | 'homeExport'
  | 'evSoc'
  | 'evTarget'
  | 'evCharge';

export interface PlanChartSeries {
  key: PlanChartSeriesKey;
  label: string;
  color: string;
  dataKey?: string;
}

export const DEVICE_COLORS = ['#0ea5e9', '#8b5cf6', '#22c55e', '#eab308', '#f97316', '#ec4899', '#06b6d4', '#84cc16'];

export type ReadinessState = 'ready' | 'blocked' | 'waiting';

export type ActualSeriesKey =
  | 'load'
  | 'pv'
  | 'gridImport'
  | 'gridExport'
  | 'batteryCharge'
  | 'batteryDischarge'
  | `device:${string}`;
