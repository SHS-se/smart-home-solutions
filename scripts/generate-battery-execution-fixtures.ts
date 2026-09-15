/** Synthetic cross-language response evidence; not inverter commissioning evidence. */
import {
  type BatteryExecutionRequest,
  compileBatteryExecutionPolicy,
  evaluateExecutionContinuation,
  evaluateExecutionCurrent,
  type ExecutionConditions,
} from "../supabase/functions/_shared/battery-execution-policy.ts";

export function executionFixtureRequest(
  intervalCount = 4,
): BatteryExecutionRequest {
  const from = Date.parse("2026-09-15T08:03:00.000Z"),
    boundary = Date.parse("2026-09-15T08:15:00.000Z");
  const identity: BatteryExecutionRequest["identity"] = {
    policy_id: "synthetic-execution-1",
    revision: 1,
    battery_id: "battery",
    intent_revision: "intent-1",
    plant_revision: "plant-1",
    scope_revision: "scope-1",
    external_scenario_revision: "real-demand-1",
    tariff_revision: "tariff-1",
    response_model_revision: "pv-first-v1",
    catalog_revision: "synthetic-catalog-1",
  };
  const series = (values: number[]) =>
    Array.from({ length: intervalCount }, (_, i) => values[i % values.length]);
  return {
    problem: {
      schema_version: 1,
      identity: {
        case_id: "synthetic-execution",
        intent_revision: identity.intent_revision,
        model_revision: "plant-1",
        actuals_watermark: new Date(from).toISOString(),
        provenance: "synthetic",
      },
      intervals: Array.from(
        { length: intervalCount },
        (_, i) => ({
          start: new Date(i === 0 ? from : boundary + (i - 1) * 900000)
            .toISOString(),
          end: new Date(boundary + i * 900000).toISOString(),
        }),
      ),
      plant: {
        grid: { import_limit_w: 17000, export_limit_w: 10000 },
        pv_w: series([1000, 4000, 500, 0]),
        residual_loads: [{
          id: "base",
          power_w: series([1000, 1200, 1800, 2000]),
        }, { id: "ev-external", power_w: series([7000, 0, 0, 0]) }],
        thermal_stores: [],
        equipment: [{
          id: "battery",
          kind: "battery",
          model_id: "pv-first-v1",
          available: Array(intervalCount).fill(true),
          state_kwh: {
            initial: 5,
            min: 1,
            max: 10,
            provenance: "synthetic response evidence",
          },
          charge_max_w: 4000,
          discharge_max_w: 4000,
          charge_efficiency: 0.95,
          discharge_efficiency: 0.9,
          wear_sek_per_kwh: 0.1,
          grid_charge_allowed: Array(intervalCount).fill(true),
          export_allowed: Array(intervalCount).fill(true),
        }],
      },
      economics: {
        tariff: "energy_only",
        import_sek_per_kwh: series([-0.7, -0.3, 1.8, 0.8]),
        export_sek_per_kwh: series([-0.15, 0.3, 0.8, 0.4]),
        shaping_sek_per_kwh_per_kw: 0.025,
        ramp_sek_per_kw: 0.07,
        initial_import_w: 7000,
        services: [],
        completed_event_ids: [],
        terminal: [{
          id: "remaining-energy",
          store_id: "battery",
          curve: {
            unit: "kwh",
            points: [
              { at: 1, sek_per_unit: 0.8 },
              { at: 4, sek_per_unit: 0.5 },
              { at: 10, sek_per_unit: 0 },
            ],
          },
          coverage_from: new Date(boundary + (intervalCount - 1) * 900000)
            .toISOString(),
          model_id: "synthetic-terminal",
          event_ids: [],
        }],
      },
    },
    identity,
    validity: {
      from_ms: from,
      refresh_after_ms: boundary - 60000,
      until_ms: boundary,
      boundary_ms: boundary,
    },
    domain: {
      energy_kwh: [1, 10],
      pv_w: [0, 12000],
      residual_load_w: [0, 15000],
    },
    permissions: {
      available: true,
      grid_charge_allowed: true,
      battery_export_allowed: true,
      export_reserve_kwh: 3,
      export_price_eligible: true,
      minimum_export_price_sek_per_kwh: -0.25,
      price_revision: identity.tariff_revision,
    },
    reference_id: "hold",
    operations: [
      {
        id: "hold",
        operation: "hold",
        charge_limit_w: 0,
        discharge_limit_w: 0,
      },
      {
        id: "msc",
        operation: "self_consumption",
        charge_limit_w: 4000,
        discharge_limit_w: 4000,
      },
      {
        id: "solar",
        operation: "solar_charge",
        charge_limit_w: 3000,
        discharge_limit_w: 0,
      },
      {
        id: "house",
        operation: "supply_house",
        charge_limit_w: 0,
        discharge_limit_w: 3000,
      },
      {
        id: "charge",
        operation: "grid_charge",
        charge_limit_w: 3000,
        discharge_limit_w: 0,
      },
      {
        id: "export",
        operation: "export",
        charge_limit_w: 0,
        discharge_limit_w: 2000,
      },
    ],
    projection: {
      view: "executable",
      scope_revision: identity.scope_revision,
      external_scenario_revision: identity.external_scenario_revision,
      configured_participant_ids: ["base", "ev-external"],
      participants: [{ id: "base", basis: "measured_base" }, {
        id: "ev-external",
        basis: "expected_behaviour",
      }],
    },
    search: {
      energy_levels_kwh: [1, 3, 5, 7, 10],
      retained_per_level: 4,
      max_interval_evaluations: 1_000_000,
    },
  };
}

export function executionCurrentVectors(request = executionFixtureRequest()) {
  const result = compileBatteryExecutionPolicy(request);
  if (result.status !== "compiled") throw new Error(result.reason);
  const policy = result.policy;
  const base: ExecutionConditions = {
    at_ms: policy.validity.from_ms,
    energy_kwh: 5,
    pv_w: 1000,
    residual_load_w: 8000,
    previous_import_w: 7000,
  };
  const frames: { id: string; changes: Partial<ExecutionConditions> }[] = [
    { id: "negative-price-real-7kw-ev", changes: {} },
    {
      id: "historical-import-above-limit",
      changes: { previous_import_w: 25000 },
    },
    {
      id: "live-pv-surplus",
      changes: {
        at_ms: base.at_ms + 180000,
        pv_w: 6000,
        residual_load_w: 1500,
      },
    },
    {
      id: "live-load-change-ramp",
      changes: {
        at_ms: base.at_ms + 300000,
        pv_w: 500,
        residual_load_w: 10000,
        previous_import_w: 250,
      },
    },
    {
      id: "fractional-charge-saturation",
      changes: {
        energy_kwh: 9.9991234567,
        pv_w: 6000,
        residual_load_w: 1000,
        previous_import_w: 4500,
      },
    },
    {
      id: "fractional-discharge-saturation",
      changes: { energy_kwh: 1.0001234567, previous_import_w: 500 },
    },
    {
      id: "at-capacity",
      changes: { energy_kwh: 10, pv_w: 6000, residual_load_w: 1000 },
    },
    { id: "at-cutoff", changes: { energy_kwh: 1 } },
    { id: "at-export-reserve", changes: { energy_kwh: 3 } },
    { id: "export-reserve-crossing", changes: { energy_kwh: 3.1 } },
    {
      id: "no-pv-no-load",
      changes: { pv_w: 0, residual_load_w: 0, previous_import_w: 3000 },
    },
    {
      id: "uncontained-pv",
      changes: { energy_kwh: 10, pv_w: 12000, residual_load_w: 0 },
    },
    {
      id: "last-millisecond",
      changes: { at_ms: policy.validity.until_ms - 1 },
    },
    { id: "expired", changes: { at_ms: policy.validity.until_ms } },
    { id: "outside-energy-domain", changes: { energy_kwh: 0.9 } },
  ];
  return {
    schema: "battery-execution-current-vectors-v1",
    policy,
    cases: frames.flatMap(({ id, changes }) =>
      policy.operations.map((operation) => {
        const conditions = { ...base, ...changes };
        return {
          id: `${id}-${operation.id}`,
          ...conditions,
          operation_id: operation.id,
          expected: evaluateExecutionCurrent(policy, operation, conditions),
        };
      })
    ),
  };
}

export function executionContinuationVectors(
  request = executionFixtureRequest(),
) {
  const result = compileBatteryExecutionPolicy(request);
  if (result.status !== "compiled") throw new Error(result.reason);
  const policy = result.policy;
  const points = new Set<string>();
  for (const cell of policy.continuation.cells) {
    const [lo, hi] = cell.domain.energy_kwh;
    for (const energy of [lo, lo + (hi - lo) * 0.371, hi]) {
      for (const previous of [0, 731.25, policy.plant.import_limit_w]) {
        points.add(JSON.stringify([energy, previous]));
      }
    }
  }
  points.add(JSON.stringify([1.01, 0]));
  points.add(JSON.stringify([0.9, 0]));
  points.add(JSON.stringify([5, policy.plant.import_limit_w + 1]));
  return {
    schema: "battery-execution-continuation-vectors-v1",
    policy,
    cases: [...points].map((point, index) => {
      const [energy_kwh, previous_import_w] = JSON.parse(point) as [
        number,
        number,
      ];
      return {
        id: `continuation-${index}`,
        energy_kwh,
        previous_import_w,
        expected: evaluateExecutionContinuation(
          policy,
          energy_kwh,
          previous_import_w,
        ),
      };
    }),
  };
}

if (import.meta.main) {
  const check = Deno.args.includes("--check");
  if (Deno.args.some((arg) => arg !== "--check")) {
    throw new Error("Only --check is supported");
  }
  const folder = new URL(
    "../docs/energy-optimisation/fixtures/battery-execution/",
    import.meta.url,
  );
  const vectors = executionCurrentVectors();
  const native = executionFixtureRequest(1);
  native.permissions.grid_charge_allowed =
    native.permissions
      .battery_export_allowed =
      false;
  const battery = native.problem.plant.equipment[0];
  if (battery.kind !== "battery") throw new Error("fixture battery missing");
  battery.grid_charge_allowed.fill(false);
  battery.export_allowed.fill(false);
  const files = {
    "policy.json": vectors.policy,
    "current-vectors.json": vectors,
    "native-permissions-current-vectors.json": executionCurrentVectors(native),
    "continuation-vectors.json": executionContinuationVectors(),
  };
  if (!check) await Deno.mkdir(folder, { recursive: true });
  for (const [name, value] of Object.entries(files)) {
    const contents = JSON.stringify(value, null, 2) + "\n";
    const path = new URL(name, folder);
    if (check) {
      if (await Deno.readTextFile(path) !== contents) {
        throw new Error(`Stale fixture: ${name}`);
      }
    } else await Deno.writeTextFile(path, contents);
  }
  console.log(
    `${
      check ? "Verified" : "Generated"
    } ${vectors.policy.continuation.cells.length} cells, ${vectors.cases.length} primary current vectors and ${
      files["continuation-vectors.json"].cases.length
    } continuation vectors`,
  );
}
