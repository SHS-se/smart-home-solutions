/** Closed resolved-model input for scoring and projections, not an HA plan schema. */
import { z } from "zod";
import { validateCurve } from "./store-value.ts";

const finite = z.number().finite();
const nonnegative = finite.nonnegative();
const positive = finite.positive();
const id = z.string().min(1);
const utc = z.string().datetime();
const series = z.array(finite);
const nonnegativeSeries = z.array(nonnegative);
const levels = z.array(nonnegative).min(1).refine(
  (values) =>
    values[0] === 0 && values.every((v, i) => i === 0 || v > values[i - 1]),
  "levels must start at zero and increase strictly",
);
const curve = z.object({
  unit: z.enum(["kwh", "celsius"]),
  points: z.array(
    z.object({ at: nonnegative, sek_per_unit: nonnegative }).strict(),
  ).min(1),
}).strict().transform((value) => ({
  unit: value.unit,
  points: value.points.map((p) => ({ at: p.at, sek_per_unit: p.sek_per_unit })),
})).superRefine((value, context) => {
  const error = validateCurve(value);
  if (error) context.addIssue({ code: "custom", message: error.detail });
});
const bounds = z.object({
  initial: nonnegative,
  min: nonnegative,
  max: positive,
  provenance: id,
}).strict().refine(
  (v) => v.min <= v.initial && v.initial <= v.max && v.min < v.max,
  "initial state must lie within ordered physical bounds",
);
const common = { id, model_id: id, available: z.array(z.boolean()) };
const battery = z.object({
  ...common,
  kind: z.literal("battery"),
  state_kwh: bounds,
  charge_max_w: nonnegative,
  discharge_max_w: nonnegative,
  charge_efficiency: positive.max(1),
  discharge_efficiency: positive.max(1),
  wear_basis: z.enum(["ac_throughput", "discharged_storage"]),
  wear_sek_per_kwh: nonnegative,
  grid_charge_allowed: z.array(z.boolean()),
  export_allowed: z.array(z.boolean()),
}).strict();
const ev = z.object({
  ...common,
  kind: z.literal("ev"),
  state_kwh: bounds,
  watts_per_amp: positive,
  current_steps_a: levels,
  charge_efficiency: positive.max(1),
  wear_sek_per_kwh: nonnegative,
  connected: z.array(z.boolean()),
}).strict();
const heater = z.object({
  ...common,
  kind: z.literal("heater"),
  technology: z.enum(["heat_pump", "resistive"]),
  power_steps_w: levels,
  initially_running: z.boolean(),
  start_cost_sek: nonnegative,
  routes: z.array(
    z.object({ store_id: id, cop: z.array(positive), auxiliary_w: nonnegative })
      .strict(),
  ).min(1),
}).strict();
const equipment = z.discriminatedUnion("kind", [battery, ev, heater]);
const thermal = z.object({
  id,
  model_id: id,
  role: z.enum(["room", "pool", "tank"]),
  state_c: bounds,
  capacity_kwh_per_c: positive,
  loss_kw_per_c: nonnegative,
  environment_c: series,
  background_kw: series,
  withdrawal_kwh: nonnegativeSeries,
}).strict();
const service = z.discriminatedUnion("kind", [
  z.object({
    id,
    kind: z.literal("continuous"),
    store_id: id,
    curves: z.array(curve),
  }).strict(),
  z.object({ id, kind: z.literal("event"), store_id: id, at: utc, curve })
    .strict(),
]);
export const householdProblemSchema = z.object({
  schema_version: z.literal(2),
  identity: z.object({
    case_id: id,
    intent_revision: id,
    model_revision: id,
    actuals_watermark: utc,
    provenance: z.enum(["synthetic", "resolved"]),
  }).strict(),
  intervals: z.array(z.object({ start: utc, end: utc }).strict()).min(1).max(
    17280,
  ),
  plant: z.object({
    grid: z.object({ import_limit_w: nonnegative, export_limit_w: nonnegative })
      .strict(),
    pv_w: nonnegativeSeries,
    residual_loads: z.array(
      z.object({ id, power_w: nonnegativeSeries }).strict(),
    ),
    thermal_stores: z.array(thermal),
    equipment: z.array(equipment),
  }).strict(),
  economics: z.object({
    tariff: z.literal("energy_only"),
    import_sek_per_kwh: series,
    export_sek_per_kwh: series,
    shaping_sek_per_kwh_per_kw: nonnegative,
    ramp_sek_per_kw: nonnegative,
    initial_import_w: nonnegative.nullable(),
    services: z.array(service),
    completed_event_ids: z.array(id),
    terminal: z.array(
      z.object({
        id,
        store_id: id,
        curve,
        coverage_from: utc,
        model_id: id,
        event_ids: z.array(id),
      }).strict(),
    ),
  }).strict(),
}).strict();
// The repository disables strictNullChecks, which makes Zod infer required fields
// as optional. Parsing still enforces them; restore required domain fields here.
type RequiredFields<T> = T extends unknown[] ? RequiredFields<T[number]>[]
  : T extends object ? { [K in keyof T]-?: RequiredFields<T[K]> }
  : T;
export type HouseholdProblem = RequiredFields<
  z.infer<typeof householdProblemSchema>
>;
export type HouseholdPlant = HouseholdProblem["plant"];
export type Equipment = HouseholdPlant["equipment"][number];

export const householdCandidateSchema = z.object({
  id,
  pv_curtail_w: nonnegativeSeries,
  actions: z.record(z.array(z.discriminatedUnion("kind", [
    z.object({
      kind: z.literal("battery"),
      charge_w: nonnegative,
      discharge_w: nonnegative,
      solar_charge_w: nonnegative,
      export_w: nonnegative,
    }).strict(),
    z.object({ kind: z.literal("ev"), current_a: nonnegative }).strict(),
    z.object({
      kind: z.literal("heater"),
      store_id: id.nullable(),
      power_w: nonnegative,
    }).strict(),
  ]))),
}).strict();
export type HouseholdCandidate = RequiredFields<
  z.infer<typeof householdCandidateSchema>
>;
export interface Violation {
  path: string;
  message: string;
}

/** Validate cross-references and exact series; never fill gaps or invent models. */
export function parseHouseholdProblem(input: unknown): HouseholdProblem {
  const p = householdProblemSchema.parse(input) as HouseholdProblem;
  const n = p.intervals.length;
  const fail = (message: string): never => {
    throw new Error(`Invalid household problem: ${message}`);
  };
  const length = (values: unknown[], path: string) => {
    if (values.length !== n) fail(`${path} must contain exactly ${n} values`);
  };
  const unique = (values: string[], path: string) => {
    if (new Set(values).size !== values.length) {
      fail(`${path} contains duplicate identities`);
    }
  };
  const start = Date.parse(p.intervals[0].start);
  const end = Date.parse(p.intervals[n - 1].end);
  const boundaries = new Set(
    p.intervals.flatMap((v) => [Date.parse(v.start), Date.parse(v.end)]),
  );
  if (Date.parse(p.identity.actuals_watermark) !== start) {
    fail("initial state watermark must match horizon start");
  }
  p.intervals.forEach((v, i) => {
    const a = Date.parse(v.start), b = Date.parse(v.end);
    if (
      b <= a || b - a > 900000 ||
      Math.floor(a / 900000) !== Math.floor((b - 1) / 900000)
    ) {
      fail(`interval ${i} must be positive and stay within one UTC quarter`);
    }
    if (i && Date.parse(p.intervals[i - 1].end) !== a) {
      fail(`gap/overlap at interval ${i}`);
    }
  });
  const plant = p.plant;
  unique(
    [...plant.residual_loads, ...plant.thermal_stores, ...plant.equipment].map(
      (v) => v.id,
    ),
    "plant",
  );
  length(plant.pv_w, "pv_w");
  plant.residual_loads.forEach((v) => length(v.power_w, v.id));
  const units = new Map<string, "kwh" | "celsius">();
  plant.thermal_stores.forEach((s) => {
    units.set(s.id, "celsius");
    length(s.environment_c, s.id);
    length(s.background_kw, s.id);
    length(s.withdrawal_kwh, s.id);
    p.intervals.forEach((v, i) => {
      const h = (Date.parse(v.end) - Date.parse(v.start)) / 3600000;
      if (s.loss_kw_per_c * h > s.capacity_kwh_per_c) {
        fail(`${s.id}: unstable thermal timestep at ${i}`);
      }
    });
  });
  plant.equipment.forEach((e) => {
    length(e.available, e.id);
    if (e.kind === "battery") {
      units.set(e.id, "kwh");
      length(e.grid_charge_allowed, e.id);
      length(e.export_allowed, e.id);
    } else if (e.kind === "ev") {
      units.set(e.id, "kwh");
      length(e.connected, e.id);
    } else {
      unique(e.routes.map((r) => r.store_id), `${e.id} routes`);
      if (e.technology === "resistive" && e.start_cost_sek !== 0) {
        fail("resistive equipment cannot have start costs");
      }
      e.routes.forEach((r) => {
        if (units.get(r.store_id) !== "celsius") {
          fail(`${e.id}: unknown thermal store ${r.store_id}`);
        }
        length(r.cop, e.id);
        if (e.technology === "resistive" && r.cop.some((c) => c > 1)) {
          fail("resistive efficiency exceeds 1");
        }
      });
    }
  });
  const econ = p.economics;
  length(econ.import_sek_per_kwh, "import prices");
  length(econ.export_sek_per_kwh, "export prices");
  unique(
    [...econ.services, ...econ.terminal].map((s) => s.id),
    "economic benefit",
  );
  unique(econ.completed_event_ids, "completed events");
  unique(econ.terminal.map((t) => t.store_id), "terminal store coverage");
  unique(econ.terminal.flatMap((t) => t.event_ids), "terminal event coverage");
  const eventMap = new Map(
    econ.services.filter((s) => s.kind === "event").map((s) => [s.id, s]),
  );
  econ.completed_event_ids.forEach((e) => {
    const event = eventMap.get(e);
    if (!event || Date.parse(event.at) > start) {
      fail(`invalid completed event ${e}`);
    }
  });
  const checkCurve = (store: string, c: z.infer<typeof curve>) => {
    if (units.get(store) !== c.unit) {
      fail(`unknown store or wrong curve unit: ${store}`);
    }
  };
  econ.services.forEach((s) => {
    if (s.kind === "continuous") {
      if (units.get(s.store_id) !== "celsius") {
        fail("continuous service requires a thermal store");
      }
      length(s.curves, s.id);
      s.curves.forEach((c) => checkCurve(s.store_id, c));
    } else {
      checkCurve(s.store_id, s.curve);
      const at = Date.parse(s.at);
      if (at < start && !econ.completed_event_ids.includes(s.id)) {
        fail(`past event ${s.id} needs reconciled completion`);
      }
      if (at >= start && at <= end && !boundaries.has(at)) {
        fail(`event ${s.id} must be at an interval boundary`);
      }
    }
  });
  econ.terminal.forEach((t) => {
    checkCurve(t.store_id, t.curve);
    if (Date.parse(t.coverage_from) < end) {
      fail(`terminal ${t.id} overlaps the horizon`);
    }
    t.event_ids.forEach((id) => {
      const event = eventMap.get(id);
      if (
        !event || event.store_id !== t.store_id ||
        Date.parse(event.at) <= end ||
        Date.parse(event.at) < Date.parse(t.coverage_from)
      ) fail(`terminal ${t.id} claims incompatible event ${id}`);
    });
  });
  return p;
}

export function candidateIssues(
  p: HouseholdProblem,
  c: HouseholdCandidate,
): Violation[] {
  const issues: Violation[] = [];
  const n = p.intervals.length;
  const expected = new Set(p.plant.equipment.map((e) => e.id));
  const issue = (path: string, message: string) =>
    issues.push({ path, message });
  if (c.pv_curtail_w.length !== n) {
    issue("pv_curtail_w", `expected ${n} values`);
  }
  for (const key of Object.keys(c.actions)) {
    if (!expected.has(key)) issue(`actions.${key}`, "unknown equipment");
  }
  for (const e of p.plant.equipment) {
    const actions = Object.prototype.hasOwnProperty.call(c.actions, e.id)
      ? c.actions[e.id]
      : undefined;
    if (!actions || actions.length !== n) {
      issue(`actions.${e.id}`, `expected ${n} actions`);
      continue;
    }
    actions.forEach((a, i) => {
      if (a.kind !== e.kind) {
        issue(`actions.${e.id}.${i}`, "action kind does not match equipment");
      }
      if (
        a.kind === "heater" && e.kind === "heater" && a.store_id !== null &&
        !e.routes.some((r) => r.store_id === a.store_id)
      ) issue(`actions.${e.id}.${i}.store_id`, "unknown route");
    });
  }
  return issues;
}
