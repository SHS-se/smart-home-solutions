import { assert, assertEquals } from "@std/assert";
import { auditQuarterReplay } from "../scripts/lib/quarter-replay-audit.ts";

function capture() {
  const battery = {
    capacity_kwh: 10,
    soc: 0.5,
    min_soc: 0.1,
    max_soc: 0.9,
    charge_max_w: 2000,
    discharge_max_w: 2000,
    charge_efficiency: 0.8,
    discharge_efficiency: 0.9,
  };
  const grid = { import_limit_w: 3000, export_limit_w: 3000 };
  const first = {
    start: "2026-09-14T12:00:00+00:00",
    duration_hours: 0.125,
    binding: true,
    base_w: 900,
    device_loads_w: { boiler: 100 },
    pool_w: 0,
    boiler_expected_w: 100,
    ev_w: 0,
    pv_w: 500,
    load_w: 1000,
    battery_charge_w: 1000,
    battery_discharge_w: 0,
    battery_export_w: 0,
    battery_soc: 0.51,
    grid_import_w: 1500,
    grid_export_w: 0,
    curtailed_w: 0,
    unserved_w: 0,
    import_price_sek_per_kwh: -1,
    export_price_sek_per_kwh: 0.5,
    import_cost_sek: -0.1875,
    export_revenue_sek: 0,
  };
  const second = {
    ...first,
    start: "2026-09-14T12:15:00Z",
    duration_hours: 0.25,
    binding: false,
    base_w: 1000,
    device_loads_w: { boiler: 0 },
    boiler_expected_w: 0,
    pv_w: 100,
    battery_charge_w: 0,
    battery_discharge_w: 900,
    battery_soc: 0.485,
    grid_import_w: 0,
    import_price_sek_per_kwh: null,
    export_price_sek_per_kwh: null,
    import_cost_sek: null,
    export_revenue_sek: null,
  };
  return {
    format: "shs-energy-optimisation-quarter-replay",
    schema_version: 2,
    entrypoint: {
      module: "THIS MUST NEVER EXECUTE",
      arguments: {
        now: "2026-09-14T12:07:30Z",
        snapshot: {
          schema_version: 8,
          snapshot_id: "synthetic",
          captured_at: "2026-09-14T12:07:00Z",
          battery,
          grid,
          device_models: [{
            key: "boiler",
            category: "hot_water",
            planning_service: null,
          }],
        },
      },
    },
    expected: {
      planner_output: {
        schema_version: 8,
        snapshot_id: "synthetic",
        model_version: "synthetic-accounting-test",
        issued_at: "2026-09-14T12:07:30Z",
        battery: { ...battery },
        grid: { ...grid },
        plans: {
          cost: {
            slots: [first, second],
            summary: {
              load_kwh: 0.375,
              pv_kwh: 0.088,
              grid_import_kwh: 0.188,
              grid_export_kwh: 0,
              curtailed_kwh: 0,
              priced_import_kwh: 0.188,
              priced_export_kwh: 0,
              net_cost_sek: -0.188,
              battery_soc_start: 0.5,
              battery_soc_end: 0.485,
              battery_soc_low: 0.485,
            },
          },
        },
      },
    },
  };
}

type Capture = ReturnType<typeof capture>;
function checks(input: unknown) {
  const result = auditQuarterReplay(input);
  assert(result.status !== "invalid_capture");
  return [...result.issues, ...result.scenarios.flatMap((s) => s.issues)].map(
    (i) => i.check,
  );
}
function rejects(check: string, change: (input: Capture) => void) {
  const input = capture();
  change(input);
  assert(checks(input).includes(check), `Expected ${check}`);
}

Deno.test("capture audit accounts for partial quarters, negative prices, battery losses and unpriced suffix", () => {
  const input = capture();
  const saved = structuredClone(input);
  const result = auditQuarterReplay(input);
  assertEquals(result.status, "passed");
  assert(result.status !== "invalid_capture");
  assertEquals(result.scenarios[0].horizon_hours, 0.375);
  assertEquals(result.scenarios[0].binding_hours, 0.125);
  assertEquals(result.scenarios[0].totals.net_cost_sek, -0.1875);
  assertEquals(result.scenarios[0].totals.load_kwh, 0.375);
  assertEquals(input, saved);
  assert(!("objective" in result));
  assert(result.unresolved_for_household_scoring.length > 0);
});

Deno.test("capture audit rejects unsupported schemas and nonfinite or absent operands", () => {
  const changes = [
    (c: Capture) => {
      c.schema_version = 1;
    },
    (c: Capture) => {
      c.entrypoint.arguments.snapshot.schema_version = 7;
    },
    (c: Capture) => {
      c.expected.planner_output.plans.cost.slots[0].load_w = NaN;
    },
    (c: Capture) => {
      delete (c.expected.planner_output.plans.cost.slots[0] as Partial<
        Capture["expected"]["planner_output"]["plans"]["cost"]["slots"][0]
      >).battery_charge_w;
    },
    (c: Capture) => {
      c.entrypoint.arguments.snapshot.battery.capacity_kwh = 0;
    },
  ];
  for (const change of changes) {
    const input = capture();
    change(input);
    assertEquals(auditQuarterReplay(input).status, "invalid_capture");
  }
});

Deno.test("capture audit detects identity and issue-time drift", () => {
  rejects("snapshot_identity", (c) => {
    c.expected.planner_output.snapshot_id = "other";
  });
  rejects("battery_identity", (c) => {
    c.expected.planner_output.battery.soc = 0.6;
  });
  rejects("grid_identity", (c) => {
    c.expected.planner_output.grid.import_limit_w = 100;
  });
  rejects("plan_time", (c) => {
    c.entrypoint.arguments.now = "2026-09-14T12:08:00Z";
  });
  rejects("snapshot_time", (c) => {
    c.entrypoint.arguments.snapshot.captured_at = "2026-09-14T13:00:00Z";
  });
});

Deno.test("capture audit catches full-quarter first-slot accounting and missing quarters", () => {
  rejects("interval_duration", (c) => {
    c.expected.planner_output.plans.cost.slots[0].duration_hours = 0.25;
  });
  rejects("quarter_sequence", (c) => {
    c.expected.planner_output.plans.cost.slots[1].start =
      "2026-09-14T12:30:00Z";
  });
});

Deno.test("capture audit catches clamped battery states and independently checks limits", () => {
  rejects("battery_evolution", (c) => {
    c.expected.planner_output.plans.cost.slots[0].battery_soc = 0.9;
  });
  rejects("battery_min_soc", (c) => {
    c.expected.planner_output.plans.cost.slots[1].battery_soc = 0.05;
  });
  rejects("battery_charge_limit_w", (c) => {
    c.expected.planner_output.plans.cost.slots[0].battery_charge_w = 2100;
  });
  rejects("battery_direction", (c) => {
    c.expected.planner_output.plans.cost.slots[0].battery_discharge_w = 1;
  });
  rejects("battery_export_allocation_w", (c) => {
    c.expected.planner_output.plans.cost.slots[1].battery_export_w = 10;
  });
});

Deno.test("capture audit distinguishes balanced but unserved demand from feasible delivery", () => {
  const input = capture();
  const s = input.expected.planner_output.plans.cost.slots[0];
  s.unserved_w = 500;
  s.grid_import_w -= 500;
  const found = checks(input);
  assert(found.includes("unserved_load"));
  assert(!found.includes("electrical_balance_w"));
  rejects("electrical_balance_w", (c) => {
    c.expected.planner_output.plans.cost.slots[0].grid_import_w += 5;
  });
  rejects("grid_import_limit_w", (c) => {
    c.expected.planner_output.plans.cost.slots[0].grid_import_w = 4000;
  });
});

Deno.test("capture audit avoids double-counting device and service consumption", () => {
  assertEquals(auditQuarterReplay(capture()).status, "passed");
  rejects("load_composition_w", (c) => {
    c.expected.planner_output.plans.cost.slots[0].load_w += 100;
  });
  const input = capture();
  input.entrypoint.arguments.snapshot.device_models = [];
  for (const s of input.expected.planner_output.plans.cost.slots) {
    s.device_loads_w = {} as typeof s.device_loads_w;
  }
  assertEquals(auditQuarterReplay(input).status, "passed");
});

Deno.test("capture audit detects altered ledgers and incomplete price evidence", () => {
  rejects("import_cost_sek", (c) => {
    c.expected.planner_output.plans.cost.slots[0].import_cost_sek = 2;
  });
  rejects("binding_prices", (c) => {
    c.expected.planner_output.plans.cost.slots[0].import_price_sek_per_kwh =
      null;
  });
  rejects("nonbinding_costs", (c) => {
    c.expected.planner_output.plans.cost.slots[1].import_cost_sek = 1;
  });
  rejects("summary.net_cost_sek", (c) => {
    c.expected.planner_output.plans.cost.summary.net_cost_sek = 2;
  });
  rejects("summary.grid_import_kwh", (c) => {
    c.expected.planner_output.plans.cost.summary.grid_import_kwh = 0.375;
  });
});

Deno.test("capture audit accepts bounded serialization rounding but detects larger SOC errors", () => {
  const input = capture();
  input.expected.planner_output.plans.cost.slots[0].battery_charge_w += 0.004;
  assertEquals(auditQuarterReplay(input).status, "passed");
  rejects("battery_evolution", (c) => {
    c.expected.planner_output.plans.cost.slots[0].battery_soc += 0.000005;
  });
});

Deno.test("capture audit detects cumulative SOC drift even when adjacent steps fit rounding bounds", () => {
  const input = capture();
  const plan = input.expected.planner_output.plans.cost;
  plan.slots[0].battery_soc += 0.0000004;
  plan.slots[1].battery_soc += 0.0000013;
  const found = checks(input);
  assert(!found.includes("battery_evolution"));
  assert(found.includes("battery_evolution_from_initial"));
});

Deno.test("capture audit reconciles PV curtailment, export revenue and priced export totals", () => {
  const input = capture();
  const plan = input.expected.planner_output.plans.cost;
  Object.assign(plan.slots[0], {
    pv_w: 2600,
    grid_import_w: 0,
    grid_export_w: 500,
    curtailed_w: 100,
    import_cost_sek: 0,
    export_revenue_sek: 0.03125,
  });
  Object.assign(plan.summary, {
    pv_kwh: 0.350,
    grid_import_kwh: 0,
    priced_import_kwh: 0,
    grid_export_kwh: 0.063,
    priced_export_kwh: 0.063,
    curtailed_kwh: 0.013,
    net_cost_sek: -0.031,
  });
  assertEquals(auditQuarterReplay(input).status, "passed");
  plan.slots[0].export_revenue_sek = 0.0315;
  assert(checks(input).includes("export_revenue_sek"));
});
