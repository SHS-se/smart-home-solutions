import {
  generateOptimisationPlan,
  type OptimisationSnapshotV6,
  type OptimisationSnapshotV8,
} from "../supabase/functions/_shared/energy-optimisation.ts";

const NOW = new Date("2026-08-20T08:55:00.000Z");
const SLOT_MS = 15 * 60_000;

export function dispatchedEvSnapshot(): OptimisationSnapshotV6 {
  const first = Date.parse("2026-08-20T09:00:00.000Z");
  const slots = Array.from({ length: 64 }, (_value, index) => ({
    start: new Date(first + index * SLOT_MS).toISOString(),
    pv_forecast_w: index >= 8 && index < 32 ? 7_000 : 0,
    base_load_forecast_w: 700,
    base_load_p10_w: 500,
    base_load_p90_w: 1_000,
    import_price_sek_per_kwh: 1.5,
    export_price_sek_per_kwh: 0.1,
  }));
  const validUntil = new Date(first + slots.length * SLOT_MS).toISOString();
  const source = (provider: string, entityIds: string[]) => ({
    provider,
    entity_ids: entityIds,
    issued_at: NOW.toISOString(),
    valid_until: validUntil,
    quality: "provider_raw" as const,
  });
  return {
    schema_version: 6,
    mode: "live",
    capabilities: {
      pv: true,
      battery: false,
      pool: false,
      boiler: false,
      ev: true,
    },
    snapshot_id: "9c8cbe63-5b50-4f4c-a0e5-a7bc4d945c43",
    captured_at: NOW.toISOString(),
    timezone: "Europe/Stockholm",
    slot_minutes: 15,
    slots,
    sources: {
      pv: {
        ...source("home_assistant_entity", ["sensor.pv_forecast"]),
        quality: "calibrated",
        sample_count: 30,
        location: { latitude: 59.3, longitude: 18.1 },
      },
      base_load: {
        ...source("home_assistant_recorder", ["sensor.house_energy"]),
        quality: "measured",
        sample_count: 1_000,
      },
      import_price: {
        ...source("shs_supplier_price", ["supplier.import.SE3"]),
        location: { market_area: "SE3" },
      },
      export_price: {
        ...source("shs_supplier_price", ["supplier.export.SE3"]),
        location: { market_area: "SE3" },
      },
      battery: null,
    },
    pv_calibration: {
      correction_factor_by_lead_day: [1, 1, 1, 1],
      sample_count_by_lead_day: [30, 0, 0, 0],
    },
    battery: null,
    ev_battery: {
      name: "Contract EV",
      connected: true,
      capacity_kwh: 75,
      soc: 0.55,
      departure_target_soc: 0.8,
      charge_efficiency: 0.92,
      kwh_per_km: 0.16,
      available_from: slots[0].start,
      departure: null,
      priority: 3,
      source_entity_ids: {
        connected: "binary_sensor.ev_connected",
        soc: "sensor.ev_soc",
        target_soc: "number.ev_target_soc",
        energy_remaining: "sensor.ev_energy_remaining",
        charge_current: "number.ev_charge_current",
      },
    },
    pool: null,
    grid: { import_limit_w: 15_000, export_limit_w: 15_000 },
    policy: {
      battery_end_of_solar_target_soc: 0,
      battery_target_is_hard: false,
      terminal_soc_min: 0,
      terminal_energy_value_sek_per_kwh: 0,
      battery_export_enabled: false,
      battery_export_reserve_soc: 0,
      battery_export_min_price_sek_per_kwh: 0,
    },
    device_models: [],
    services: [{
      id: "ev:horizon",
      device: "ev",
      earliest_start: slots[0].start,
      deadline: validUntil,
      required_kwh: 0,
      control: {
        type: "discrete_current",
        min_current_a: 5,
        max_current_a: 16,
        current_step_a: 1,
        phase_count: 3,
        voltage_v: 230,
      },
      priority: 3,
      baseline_preferred_start: slots[0].start,
    }],
    service_requirement_sample_days: {},
  };
}

export function dispatchedEvPlanFixture() {
  return {
    contract_fixture: "schema-6-dispatched-ev",
    generated_by: "generateOptimisationPlan",
    validation_time: "2026-08-20T09:00:00.000Z",
    plan: {
      ...generateOptimisationPlan(dispatchedEvSnapshot(), NOW),
      plan_id: "eedefc70-b625-42f0-be09-b1e79c0c88d9",
    },
  };
}

export function batterySnapshot(): OptimisationSnapshotV8 {
  const snapshot = dispatchedEvSnapshot();
  return {...snapshot, schema_version: 8,
    capabilities: {...snapshot.capabilities, ev: false, battery: true},
    ev_battery: null, services: [],
    policy: {...snapshot.policy, battery_end_of_solar_target_soc: .8, terminal_soc_min: .2, battery_export_reserve_soc: .8},
    battery: {capacity_kwh: 18.08, soc: .5, min_soc: .05, max_soc: 1,
      charge_max_w: 8800, discharge_max_w: 9600, charge_efficiency: .95, discharge_efficiency: .95},
    sources: {...snapshot.sources, battery: {...snapshot.sources.base_load,
      entity_ids: ["sensor.sigen_plant_battery_state_of_charge"]}},
    slots: snapshot.slots.map((slot, index) => ({...slot,
      import_price_sek_per_kwh: index < 8 ? .1 : 3})),
  };
}

export function batteryPlanFixture() {
  return {contract_fixture: "schema-8-battery", generated_by: "generateOptimisationPlan",
    validation_time: "2026-08-20T09:00:00.000Z",
    plan: {...generateOptimisationPlan(batterySnapshot(), NOW),
      plan_id: "c22f37ca-7791-4b9c-a1ec-793ba6e226bd"}};
}

if (import.meta.main) {
  await Deno.writeTextFile(new URL("../contracts/ha-api/fixtures/schema-8-battery-plan.json", import.meta.url),
    `${JSON.stringify(batteryPlanFixture(), null, 2)}\n`);
  const target = new URL(
    "../contracts/ha-api/fixtures/schema-6-dispatched-ev-plan.json",
    import.meta.url,
  );
  await Deno.mkdir(new URL(".", target), { recursive: true });
  await Deno.writeTextFile(
    target,
    `${JSON.stringify(dispatchedEvPlanFixture(), null, 2)}\n`,
  );
}
