/** Shared snapshots and helpers for the planner behaviour tests. */
import { generateOptimisationPlan, type OptimisationSnapshot } from "./energy-optimisation.ts";

/** The captured_at the shared fixture uses, so a plan is always fresh. */
export const NOW = "2026-08-10T07:55:00Z";

export const assert: (condition: boolean, message: string) => asserts condition = (
  condition,
  message,
) => {
  if (!condition) throw new Error(message);
};

export const input = (
  overrides: Partial<OptimisationSnapshot> = {},
): OptimisationSnapshot => {
  const start = Date.parse("2026-08-10T08:00:00.000Z");
  const slots = Array.from({ length: 64 }, (_, index) => ({
    start: new Date(start + index * 15 * 60_000).toISOString(),
    pv_forecast_w: index >= 8 && index < 24 ? 4_000 : 0,
    base_load_forecast_w: 500,
    import_price_sek_per_kwh: index < 20 ? 1 + index / 100 : null,
    export_price_sek_per_kwh: index < 20 ? 0.2 + index / 200 : null,
  }));
  return {
    schema_version: 5,
    mode: "live",
    capabilities: {
      pv: true,
      battery: true,
      pool: true,
      boiler: true,
      ev: false,
    },
    snapshot_id: "00000000-0000-4000-8000-000000000001",
    captured_at: "2026-08-10T07:55:00.000Z",
    timezone: "Europe/Stockholm",
    slot_minutes: 15,
    slots,
    sources: {
      pv: {
        provider: "test-pv",
        entity_ids: ["sensor.pv"],
        issued_at: "2026-08-10T07:50:00Z",
        valid_until: "2026-08-10T16:00:00Z",
        quality: "calibrated",
        sample_count: 30,
        location: { latitude: 59.3, longitude: 18.1 },
      },
      base_load: {
        provider: "recorder",
        entity_ids: ["sensor.load"],
        issued_at: "2026-08-10T07:55:00Z",
        valid_until: "2026-08-10T10:00:00Z",
        quality: "measured",
        sample_count: 960,
      },
      import_price: {
        provider: "test-import",
        entity_ids: ["sensor.buy"],
        issued_at: "2026-08-10T07:50:00Z",
        valid_until: "2026-08-10T13:00:00Z",
        quality: "provider_raw",
        location: { market_area: "SE3" },
      },
      export_price: {
        provider: "test-export",
        entity_ids: ["sensor.sell"],
        issued_at: "2026-08-10T07:50:00Z",
        valid_until: "2026-08-10T13:00:00Z",
        quality: "provider_raw",
        location: { market_area: "SE3" },
      },
      battery: {
        provider: "home-assistant-state",
        entity_ids: ["sensor.battery_soc"],
        issued_at: "2026-08-10T07:54:00Z",
        valid_until: "2026-08-10T09:10:00Z",
        quality: "measured",
        sample_count: 1,
      },
    },
    pv_calibration: {
      correction_factor_by_lead_day: [0.8, 0.75, 0.7, 0.65],
      sample_count_by_lead_day: [30, 20, 10, 5],
    },
    battery: {
      capacity_kwh: 10,
      soc: 0.4,
      min_soc: 0.05,
      max_soc: 1,
      charge_max_w: 5_000,
      discharge_max_w: 5_000,
      charge_efficiency: 0.95,
      discharge_efficiency: 0.95,
    },
    ev_battery: null,
    grid: { import_limit_w: 10_000, export_limit_w: 10_000 },
    policy: {
      battery_end_of_solar_target_soc: 0.65,
      battery_target_is_hard: true,
      terminal_soc_min: 0.05,
      terminal_energy_value_sek_per_kwh: 1,
      battery_export_enabled: false,
      battery_export_reserve_soc: 0.8,
      battery_export_min_price_sek_per_kwh: 2.5,
    },
    device_models: [],
    services: [
      {
        id: "boiler:2026-08-10",
        device: "boiler",
        earliest_start: slots[0].start,
        deadline: new Date(start + 8 * 60 * 60_000).toISOString(),
        required_kwh: 2.8,
        control: {
          type: "duty_cycle",
          rated_power_w: 3_000,
          expected_power_w_by_slot: slots.map(() => 350),
          max_consecutive_inhibit_slots: 4,
        },
        priority: 1,
      },
      {
        id: "pool:2026-08-10",
        device: "pool",
        earliest_start: slots[0].start,
        deadline: new Date(start + 8 * 60 * 60_000).toISOString(),
        required_kwh: 2,
        control: { type: "fixed_power", power_w: 2_000 },

        priority: 2,
        baseline_preferred_start: slots[12].start,
      },
    ],
    service_requirement_sample_days: { hot_water: 17, pool_heating: 17 },
    ...overrides,
  };
};

/**
 * A realistic 72-hour horizon: three solar days, the first 24 hours priced and
 * the rest left to the modelled shape, as Nord Pool actually publishes.
 *
 * The default `input()` fixture is 32 slots, which is fine for contract checks
 * and actively misleading for planning ones. Two battery defects survived every
 * test written against it — a covering band sized over the whole horizon and a
 * double-counted wear cost — because neither is visible when the horizon is
 * shorter than a single night. Planner behaviour belongs here.
 */
/**
 * A wear cost pinned by the fixture rather than inherited.
 *
 * Three tests below turn on the battery declining a round trip, and the shipped
 * default is a product figure that moves with the packs being sold (it fell
 * from 0.45 to 0.05 when the first calendar-limited pack was measured). A
 * behavioural test that reads it silently changes what it asserts, so each of
 * them states the wear it means.
 */
export const PRICED_WEAR = { battery_degradation_sek_per_kwh: 0.45 } as const;

export const horizon = (
  overrides: Partial<OptimisationSnapshot> = {},
  { peakPvW = 9_000, baseLoadW = 1_000, pricedSlots = 96 } = {},
): OptimisationSnapshot => {
  const base = input();
  const start = Date.parse("2026-08-10T08:00:00.000Z");
  const slots = Array.from({ length: 288 }, (_value, index) => {
    // The fixture's first slot is 10:00 local, so a day's shape has to be
    // anchored to that rather than to the index.
    const hour = ((index / 4) + 10) % 24;
    const pv = hour >= 6 && hour <= 18
      ? Math.round(peakPvW * Math.sin(((hour - 6) / 12) * Math.PI))
      : 0;
    const priced = index < pricedSlots;
    return {
      start: new Date(start + index * 15 * 60_000).toISOString(),
      pv_forecast_w: pv,
      base_load_forecast_w: baseLoadW,
      // A dear evening against an ordinary day, which is what makes storing and
      // spending distinguishable at all.
      import_price_sek_per_kwh: priced ? (hour >= 17 ? 2.4 : 1.6) : null,
      export_price_sek_per_kwh: priced ? 0.99 : null,
    };
  });
  return input({
    schema_version: 6,
    slots,
    outdoor_temperature_c: slots.map(() => 22),
    battery: base.battery,
    services: [],
    service_requirement_sample_days: {},
    ...overrides,
  });
};

/** A routed charger remains a control contract even when required_kwh is zero. */
export const routedEvService = (snapshot: OptimisationSnapshot) => ({
  id: "ev:horizon",
  device: "ev" as const,
  earliest_start: snapshot.slots[0].start,
  deadline: new Date(
    Date.parse(snapshot.slots.at(-1)!.start) + 15 * 60_000,
  ).toISOString(),
  required_kwh: 0,
  control: {
    type: "discrete_current" as const,
    min_current_a: 5,
    max_current_a: 16,
    current_step_a: 1,
    phase_count: 3,
    voltage_v: 230,
  },

  priority: 3,
});

/**
 * A dear, sunless first day followed by two cheap sunny ones, with the pool
 * carrying the reference home's *stored* curve — the one the editor anchored at
 * 2.51 SEK/kWh, whose urgent threshold is 7.52 and whose comfortable threshold
 * is 2.51, both above every price in this horizon.
 *
 * That curve is the point. Left as stored it outbids the whole board and the
 * pool heats through the dearest quarters available; re-anchored to what cheap
 * energy actually costs here, the same three thresholds and the same
 * `URGENT_MULTIPLE` put urgent at 3.0 and the dear day stops clearing.
 */
export const splitHorizon = (
  dearFirstDaySekPerKwh: number,
  overrides: Partial<OptimisationSnapshot> = {},
  exportSekPerKwh = 0.5,
): OptimisationSnapshot => {
  const start = Date.parse("2026-08-10T08:00:00.000Z");
  const slots = Array.from({ length: 288 }, (_value, index) => {
    const hour = ((index / 4) + 10) % 24;
    const firstDay = index < 96;
    const pv = !firstDay && hour >= 6 && hour <= 18
      ? Math.round(9_000 * Math.sin(((hour - 6) / 12) * Math.PI))
      : 0;
    return {
      start: new Date(start + index * 15 * 60_000).toISOString(),
      pv_forecast_w: pv,
      base_load_forecast_w: 1_000,
      import_price_sek_per_kwh: firstDay ? dearFirstDaySekPerKwh : 1.0,
      export_price_sek_per_kwh: exportSekPerKwh,
    };
  });
  return input({
    schema_version: 6,
    slots,
    outdoor_temperature_c: slots.map(() => 20),
    services: [],
    service_requirement_sample_days: {},
    pool: { water_temperature_c: 27, volume_m3: 55 },
    value_curves: {
      pool: {
        unit: "celsius",
        points: [
          { at: 28, sek_per_unit: 104.56 },
          { at: 30, sek_per_unit: 34.85 },
          { at: 32, sek_per_unit: 0 },
        ],
      },
    },
    ...overrides,
  });
};

export const poolKwhBetween = (
  plan: ReturnType<typeof generateOptimisationPlan>,
  from: number,
  to: number,
) =>
  plan.plans.priority.slots.slice(from, to).reduce(
    (total, slot) => total + slot.pool_w / 1_000 * 0.25,
    0,
  );
