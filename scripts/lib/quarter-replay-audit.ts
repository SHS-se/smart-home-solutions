/** Accounting audit of captured forecasts, deliberately not a household scorer. */
import { z } from "zod";

const number = z.number().finite();
const watts = number.nonnegative();
const timestamp = z.string().datetime({ offset: true });
const battery = z.object({
  capacity_kwh: number.positive(),
  soc: number.min(0).max(1),
  min_soc: number.min(0).max(1),
  max_soc: number.min(0).max(1),
  charge_max_w: watts,
  discharge_max_w: watts,
  charge_efficiency: number.positive().max(1),
  discharge_efficiency: number.positive().max(1),
}).refine(
  (b) => b.min_soc < b.max_soc && b.soc >= b.min_soc && b.soc <= b.max_soc,
  "Battery initial SOC must be within ordered bounds",
);
const grid = z.object({ import_limit_w: watts, export_limit_w: watts });
const slot = z.object({
  start: timestamp,
  duration_hours: number.positive().max(0.25),
  binding: z.boolean(),
  base_w: watts,
  device_loads_w: z.record(watts),
  pool_w: watts,
  boiler_expected_w: watts,
  ev_w: watts,
  pv_w: watts,
  load_w: watts,
  battery_charge_w: watts,
  battery_discharge_w: watts,
  battery_export_w: watts,
  battery_soc: number.min(0).max(1),
  grid_import_w: watts,
  grid_export_w: watts,
  curtailed_w: watts,
  unserved_w: watts,
  import_price_sek_per_kwh: number.nullable(),
  export_price_sek_per_kwh: number.nullable(),
  import_cost_sek: number.nullable(),
  export_revenue_sek: number.nullable(),
});
const summary = z.object({
  load_kwh: watts,
  pv_kwh: watts,
  grid_import_kwh: watts,
  grid_export_kwh: watts,
  curtailed_kwh: watts,
  priced_import_kwh: watts,
  priced_export_kwh: watts,
  net_cost_sek: number,
  battery_soc_start: number,
  battery_soc_end: number,
  battery_soc_low: number,
});

// Project only the fields this audit understands. Capsule extras (including its
// textual entrypoint and history) are data, never executable imports or commands.
const capsule = z.object({
  format: z.literal("shs-energy-optimisation-quarter-replay"),
  schema_version: z.literal(2),
  entrypoint: z.object({
    arguments: z.object({
      now: timestamp,
      snapshot: z.object({
        schema_version: z.literal(8),
        snapshot_id: z.string().min(1),
        captured_at: timestamp,
        battery,
        grid,
        device_models: z.array(z.object({
          key: z.string().min(1),
          category: z.string(),
          planning_service: z.string().nullable().optional(),
        })),
      }),
    }),
  }),
  expected: z.object({
    planner_output: z.object({
      schema_version: z.literal(8),
      snapshot_id: z.string().min(1),
      model_version: z.string().min(1),
      issued_at: timestamp,
      battery,
      grid,
      plans: z.record(z.object({ slots: z.array(slot).min(1), summary }))
        .refine(
          (plans) => Object.keys(plans).length > 0,
          "At least one scenario is required",
        ),
    }),
  }),
});

export interface AuditIssue {
  check: string;
  interval?: number;
  detail: string;
}

/** Serialized powers have 2 decimals, SOC 6, costs 5, summaries 3.
 * Bounds below propagate half a last-place unit for each operand, rather than
 * accepting a percentage of load. Small epsilon only covers float arithmetic.
 */
const POWER_ERROR = 0.005;
const SOC_ERROR = 0.0000005;
const COST_ERROR = 0.000005;
const SUMMARY_ERROR = 0.0005;
const EPS = 1e-9;

export function auditQuarterReplay(input: unknown) {
  const parsed = capsule.safeParse(input);
  if (!parsed.success) {
    return {
      status: "invalid_capture" as const,
      issues: parsed.error.issues.map((i) => ({
        check: "capture_schema",
        detail: `${i.path.join(".")}: ${i.message}`,
      })),
    };
  }
  const snapshot = parsed.data.entrypoint.arguments.snapshot;
  const plan = parsed.data.expected.planner_output;
  const b = snapshot.battery;
  const issues: AuditIssue[] = [];
  const issue = (check: string, detail: string) =>
    issues.push({ check, detail });
  if (snapshot.snapshot_id !== plan.snapshot_id) {
    issue("snapshot_identity", "Plan references a different snapshot");
  }
  if (
    Date.parse(plan.issued_at) !==
      Date.parse(parsed.data.entrypoint.arguments.now)
  ) {
    issue("plan_time", "Captured invocation time differs from plan issue time");
  }
  if (Date.parse(snapshot.captured_at) > Date.parse(plan.issued_at)) {
    issue("snapshot_time", "Snapshot was captured after plan issue time");
  }
  if (JSON.stringify(b) !== JSON.stringify(plan.battery)) {
    issue("battery_identity", "Plan battery differs from snapshot battery");
  }
  if (JSON.stringify(snapshot.grid) !== JSON.stringify(plan.grid)) {
    issue("grid_identity", "Plan grid limits differ from snapshot grid limits");
  }
  const devices = snapshot.device_models;
  if (new Set(devices.map((d) => d.key)).size !== devices.length) {
    issue("device_inventory", "Duplicate device model keys");
  }
  const hasPool = devices.some((d) => d.planning_service === "pool");
  const hasBoiler = devices.some((d) => d.category === "hot_water");
  const hasEv = devices.some((d) => d.category === "ev_charging");

  const scenarios = Object.entries(plan.plans).map(([name, scenario]) => {
    const failures: AuditIssue[] = [];
    const add = (check: string, detail: string, interval?: number) =>
      failures.push({
        check,
        detail,
        ...(interval === undefined ? {} : { interval }),
      });
    const close = (
      check: string,
      reported: number,
      expected: number,
      tolerance: number,
      interval?: number,
    ) => {
      if (Math.abs(reported - expected) > tolerance + EPS) {
        add(
          check,
          `Reported ${reported}; reconstructed ${expected}; rounding bound ${tolerance}`,
          interval,
        );
      }
    };
    const limit = (
      check: string,
      actual: number,
      max: number,
      tolerance: number,
      interval: number,
    ) => {
      if (actual > max + tolerance + EPS) {
        add(check, `${actual} exceeds ${max}`, interval);
      }
    };
    let previousSoc = b.soc;
    let reconstructedSoc = b.soc;
    let cumulativeSocTolerance = SOC_ERROR;
    let lowSoc = b.soc;
    let hours = 0;
    let bindingHours = 0;
    let unservedKwh = 0;
    let maxBalanceResidualW = 0;
    let maxSocResidual = 0;
    let costTolerance = SUMMARY_ERROR;
    const totals = {
      load_kwh: 0,
      pv_kwh: 0,
      grid_import_kwh: 0,
      grid_export_kwh: 0,
      curtailed_kwh: 0,
      priced_import_kwh: 0,
      priced_export_kwh: 0,
      net_cost_sek: 0,
    };
    scenario.slots.forEach((s, i) => {
      const start = Date.parse(s.start);
      const expectedStart = i === 0
        ? Math.floor(Date.parse(plan.issued_at) / 900000) * 900000
        : Date.parse(scenario.slots[i - 1].start) + 900000;
      close("quarter_sequence", start, expectedStart, 0, i);
      const expectedHours = i === 0
        ? (start + 900000 - Date.parse(plan.issued_at)) / 3600000
        : 0.25;
      close("interval_duration", s.duration_hours, expectedHours, 1e-12, i);
      const dt = s.duration_hours / 1000;
      hours += s.duration_hours;
      const balance = s.pv_w + s.grid_import_w + s.battery_discharge_w -
        s.load_w + s.unserved_w - s.grid_export_w - s.battery_charge_w -
        s.curtailed_w;
      maxBalanceResidualW = Math.max(maxBalanceResidualW, Math.abs(balance));
      close("electrical_balance_w", balance, 0, 8 * POWER_ERROR, i);
      if (
        Object.keys(s.device_loads_w).sort().join("\n") !==
          devices.map((d) => d.key).sort().join("\n")
      ) {
        add(
          "device_inventory",
          "Slot device loads differ from snapshot inventory",
          i,
        );
      }
      const extra = (hasPool ? 0 : s.pool_w) +
        (hasBoiler ? 0 : s.boiler_expected_w) + (hasEv ? 0 : s.ev_w);
      close(
        "load_composition_w",
        s.load_w,
        s.base_w + Object.values(s.device_loads_w).reduce((sum, w) =>
          sum + w, 0) +
          extra,
        (5 + devices.length) * POWER_ERROR,
        i,
      );
      limit(
        "grid_import_limit_w",
        s.grid_import_w,
        snapshot.grid.import_limit_w,
        POWER_ERROR,
        i,
      );
      limit(
        "grid_export_limit_w",
        s.grid_export_w,
        snapshot.grid.export_limit_w,
        POWER_ERROR,
        i,
      );
      limit(
        "battery_charge_limit_w",
        s.battery_charge_w,
        b.charge_max_w,
        POWER_ERROR,
        i,
      );
      limit(
        "battery_discharge_limit_w",
        s.battery_discharge_w,
        b.discharge_max_w,
        POWER_ERROR,
        i,
      );
      if (
        s.battery_charge_w > POWER_ERROR && s.battery_discharge_w > POWER_ERROR
      ) add("battery_direction", "Simultaneous charge and discharge", i);
      if (s.grid_import_w > POWER_ERROR && s.grid_export_w > POWER_ERROR) {
        add("grid_direction", "Simultaneous import and export", i);
      }
      limit(
        "battery_export_allocation_w",
        s.battery_export_w,
        Math.min(s.battery_discharge_w, s.grid_export_w),
        2 * POWER_ERROR,
        i,
      );
      limit("pv_curtailment_w", s.curtailed_w, s.pv_w, 2 * POWER_ERROR, i);
      limit("unserved_load_w", s.unserved_w, s.load_w, 2 * POWER_ERROR, i);
      if (s.unserved_w > POWER_ERROR) {
        add(
          "unserved_load",
          `${s.unserved_w} W of forecast demand is unserved`,
          i,
        );
      }
      unservedKwh += s.unserved_w * dt;
      const nextSoc = previousSoc +
        (s.battery_charge_w * b.charge_efficiency -
            s.battery_discharge_w / b.discharge_efficiency) *
          dt / b.capacity_kwh;
      const socTolerance = (i === 0 ? 1 : 2) * SOC_ERROR +
        POWER_ERROR * (b.charge_efficiency + 1 / b.discharge_efficiency) * dt /
          b.capacity_kwh;
      maxSocResidual = Math.max(
        maxSocResidual,
        Math.abs(s.battery_soc - nextSoc),
      );
      close("battery_evolution", s.battery_soc, nextSoc, socTolerance, i);
      limit("battery_max_soc", s.battery_soc, b.max_soc, SOC_ERROR, i);
      limit("battery_min_soc", b.min_soc, s.battery_soc, SOC_ERROR, i);
      reconstructedSoc += (s.battery_charge_w * b.charge_efficiency -
        s.battery_discharge_w / b.discharge_efficiency) * dt / b.capacity_kwh;
      cumulativeSocTolerance += POWER_ERROR *
        (b.charge_efficiency + 1 / b.discharge_efficiency) * dt /
        b.capacity_kwh;
      close(
        "battery_evolution_from_initial",
        s.battery_soc,
        reconstructedSoc,
        cumulativeSocTolerance,
        i,
      );
      previousSoc = s.battery_soc;
      lowSoc = Math.min(lowSoc, s.battery_soc);
      totals.load_kwh += s.load_w * dt;
      totals.pv_kwh += s.pv_w * dt;
      totals.grid_import_kwh += s.grid_import_w * dt;
      totals.grid_export_kwh += s.grid_export_w * dt;
      totals.curtailed_kwh += s.curtailed_w * dt;
      if (s.binding) {
        bindingHours += s.duration_hours;
        totals.priced_import_kwh += s.grid_import_w * dt;
        totals.priced_export_kwh += s.grid_export_w * dt;
        if (
          s.import_price_sek_per_kwh === null ||
          s.export_price_sek_per_kwh === null || s.import_cost_sek === null ||
          s.export_revenue_sek === null
        ) {
          add(
            "binding_prices",
            "Binding interval lacks published prices or costs",
            i,
          );
        } else {
          const imported = s.grid_import_w * dt * s.import_price_sek_per_kwh;
          const exported = s.grid_export_w * dt * s.export_price_sek_per_kwh;
          close(
            "import_cost_sek",
            s.import_cost_sek,
            imported,
            COST_ERROR +
              POWER_ERROR * dt * Math.abs(s.import_price_sek_per_kwh),
            i,
          );
          close(
            "export_revenue_sek",
            s.export_revenue_sek,
            exported,
            COST_ERROR +
              POWER_ERROR * dt * Math.abs(s.export_price_sek_per_kwh),
            i,
          );
          totals.net_cost_sek += imported - exported;
          costTolerance += POWER_ERROR * dt *
            (Math.abs(s.import_price_sek_per_kwh) +
              Math.abs(s.export_price_sek_per_kwh));
        }
      } else if (s.import_cost_sek !== null || s.export_revenue_sek !== null) {
        add(
          "nonbinding_costs",
          "Nonbinding interval must not report a billable cost",
          i,
        );
      }
    });
    for (const [key, value] of Object.entries(totals)) {
      close(
        `summary.${key}`,
        scenario.summary[key as keyof typeof totals],
        value,
        key === "net_cost_sek"
          ? costTolerance
          : SUMMARY_ERROR + POWER_ERROR * hours / 1000,
      );
    }
    close(
      "summary.battery_soc_start",
      scenario.summary.battery_soc_start,
      b.soc,
      0,
    );
    close(
      "summary.battery_soc_end",
      scenario.summary.battery_soc_end,
      previousSoc,
      0,
    );
    close(
      "summary.battery_soc_low",
      scenario.summary.battery_soc_low,
      lowSoc,
      SOC_ERROR,
    );
    return {
      name,
      status: failures.length ? "failed" as const : "passed" as const,
      intervals: scenario.slots.length,
      horizon_hours: hours,
      binding_hours: bindingHours,
      totals,
      unserved_kwh: unservedKwh,
      max_balance_residual_w: maxBalanceResidualW,
      max_soc_residual: maxSocResidual,
      issues: failures,
    };
  });
  return {
    status: issues.length || scenarios.some((s) => s.status === "failed")
      ? "failed" as const
      : "passed" as const,
    audit_version: "quarter-accounting-v1",
    scope:
      "Captured forecast electrical accounting; no whole-household economic score or hardware validation",
    model_version: plan.model_version,
    issued_at: plan.issued_at,
    issues,
    scenarios,
    unresolved_for_household_scoring: [
      "Resolved thermal states, losses, withdrawals, COP and service utility on one common horizon",
      "Shared equipment routes, availability and native response/transition evidence",
      "Explicit source allocations, equipment wear, dated service events and terminal value coverage",
      "Model provenance and replayable actuals watermark; capture time alone does not establish reconciled actuals",
    ],
  };
}
