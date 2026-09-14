import {
  assert,
  assertAlmostEquals,
  assertEquals,
  assertThrows,
} from "@std/assert";
import {
  createHouseholdScorer,
  type HouseholdScore,
} from "./household-score.ts";
import type {
  Equipment,
  HouseholdCandidate,
  HouseholdProblem,
} from "./household-case.ts";
import { scoreDispatch } from "./dispatch-plan.ts";

const stamp = (minutes: number) =>
  new Date(Date.parse("2026-09-14T08:00:00Z") + minutes * 60000).toISOString();
const zeros = (n: number) => Array(n).fill(0);
const bools = (n: number) => Array(n).fill(true);
const bounds = (initial: number, max = 100) => ({
  initial,
  min: 0,
  max,
  provenance: "synthetic physical rating",
});
const curve = (unit: "kwh" | "celsius", value: number) => ({
  unit,
  points: [
    { at: 100, sek_per_unit: value },
    { at: 101, sek_per_unit: 0 },
  ],
});
function problem(n = 4): HouseholdProblem {
  return {
    schema_version: 1,
    identity: {
      case_id: "analytical",
      intent_revision: "intent-1",
      model_revision: "synthetic-1",
      actuals_watermark: stamp(0),
      provenance: "synthetic",
    },
    intervals: Array.from(
      { length: n },
      (_, i) => ({ start: stamp(i * 15), end: stamp((i + 1) * 15) }),
    ),
    plant: {
      grid: { import_limit_w: 20000, export_limit_w: 20000 },
      pv_w: zeros(n),
      residual_loads: [{ id: "residual", power_w: Array(n).fill(1000) }],
      thermal_stores: [],
      equipment: [],
    },
    economics: {
      tariff: "energy_only",
      import_sek_per_kwh: Array(n).fill(2),
      export_sek_per_kwh: Array(n).fill(1),
      shaping_sek_per_kwh_per_kw: 0,
      ramp_sek_per_kw: 0,
      initial_import_w: null,
      services: [],
      completed_event_ids: [],
      terminal: [],
    },
  };
}
function battery(n = 4): Equipment {
  return {
    id: "battery",
    kind: "battery",
    model_id: "ideal-storage",
    available: bools(n),
    state_kwh: bounds(2, 10),
    charge_max_w: 4000,
    discharge_max_w: 4000,
    charge_efficiency: 1,
    discharge_efficiency: 1,
    wear_sek_per_kwh: 0.1,
    grid_charge_allowed: bools(n),
    export_allowed: bools(n),
  };
}
function ev(n = 4): Equipment {
  return {
    id: "ev",
    kind: "ev",
    model_id: "resolved-ac",
    available: bools(n),
    state_kwh: bounds(38),
    current_steps_a: [0, 5, 10],
    watts_per_amp: 400,
    charge_efficiency: 1,
    wear_sek_per_kwh: 0,
    connected: bools(n),
  };
}
function addThermal(p: HouseholdProblem, id: string, initial = 20) {
  const n = p.intervals.length;
  p.plant.thermal_stores.push({
    id,
    role: "room",
    model_id: "lumped-thermal-v1",
    state_c: bounds(initial),
    capacity_kwh_per_c: 1,
    loss_kw_per_c: 0,
    environment_c: Array(n).fill(10),
    background_kw: zeros(n),
    withdrawal_kwh: zeros(n),
  });
}
function heater(
  p: HouseholdProblem,
  stores: string[],
  initiallyRunning = false,
): Equipment {
  const n = p.intervals.length;
  return {
    kind: "heater",
    id: "heater",
    model_id: "constant-cop",
    available: bools(n),
    technology: "heat_pump",
    initially_running: initiallyRunning,
    start_cost_sek: 0.5,
    power_steps_w: [0, 1000, 2000, 4000],
    routes: stores.map((store_id) => ({
      store_id,
      cop: Array(n).fill(3),
      auxiliary_w: 100,
    })),
  };
}
function idle(p: HouseholdProblem): HouseholdCandidate {
  return {
    id: "idle",
    pv_curtail_w: zeros(p.intervals.length),
    actions: Object.fromEntries(
      p.plant.equipment.map((e) => [
        e.id,
        p.intervals.map(() =>
          e.kind === "battery"
            ? {
              kind: "battery",
              charge_w: 0,
              discharge_w: 0,
              solar_charge_w: 0,
              export_w: 0,
            }
            : e.kind === "ev"
            ? { kind: "ev", current_a: 0 }
            : { kind: "heater", store_id: null, power_w: 0 }
        ),
      ]),
    ),
  };
}
function scored(result: HouseholdScore) {
  assert(result.status === "scored", JSON.stringify(result));
  return result;
}
function infeasible(result: HouseholdScore, text: string) {
  assert(result.status === "physically_infeasible", JSON.stringify(result));
  assert(
    result.violations.some((v) => v.message.includes(text)),
    JSON.stringify(result.violations),
  );
  assert(!("objective" in result));
  return result;
}
function cycle(p: HouseholdProblem): HouseholdCandidate {
  p.plant.equipment.push(battery(p.intervals.length));
  const c = idle(p);
  c.actions.battery[0] = {
    kind: "battery",
    charge_w: 4000,
    discharge_w: 0,
    solar_charge_w: 0,
    export_w: 0,
  };
  c.actions.battery[1] = {
    kind: "battery",
    charge_w: 0,
    discharge_w: 4000,
    solar_charge_w: 0,
    export_w: 3000,
  };
  return c;
}

Deno.test("gross cycle conserves inventory and accounts for bill, wear and terminal separately", () => {
  const p = problem();
  const c = cycle(p);
  p.economics.terminal = [{
    id: "future-energy",
    store_id: "battery",
    curve: curve("kwh", 0.5),
    coverage_from: stamp(60),
    model_id: "post-horizon-replacement",
    event_ids: [],
  }];
  const r = scored(createHouseholdScorer(p).score(c));
  assertAlmostEquals(r.trajectory.state.battery.at(-1)!, 2);
  assertAlmostEquals(r.objective.import_sek, 3.5);
  assertAlmostEquals(r.objective.export_sek, 0.75);
  assertAlmostEquals(r.objective.wear_sek, 0.2);
  assertAlmostEquals(r.objective.terminal_sek, 1);
  assertAlmostEquals(r.objective.total_sek, 1.95);
  assertEquals(r.objective.starts_sek, 0);
  assertEquals(r.intervals.map((v) => v.objective.terminal_sek), [0, 0, 0, 0]);
  assertAlmostEquals(
    r.intervals.reduce(
      (s, v) => s + v.objective.total_sek,
      r.closing.total_sek,
    ),
    r.objective.total_sek,
  );
});

Deno.test("flow efficiencies affect physical inventory exactly once", () => {
  const p = problem();
  const c = cycle(p);
  const b = p.plant.equipment[0];
  assert(b.kind === "battery");
  b.charge_efficiency = 0.9;
  b.discharge_efficiency = 0.8;
  const r = scored(createHouseholdScorer(p).score(c));
  assertAlmostEquals(r.trajectory.state.battery.at(-1)!, 2 + 0.9 - 1 / 0.8);
  assertAlmostEquals(r.objective.wear_sek, 0.2);
});

Deno.test("whole-household grid money agrees with existing scorer on the supported electrical overlap", () => {
  const p = problem();
  p.plant.pv_w = [0, 2000, 4000, 0];
  const r = scored(createHouseholdScorer(p).score(idle(p)));
  const old = scoreDispatch(
    p.intervals.map((_, i) => ({
      pv_w: p.plant.pv_w[i],
      fixed_load_w: 1000,
      import_price_sek_per_kwh: 2,
      export_price_sek_per_kwh: 1,
    })),
    [],
    {
      grid_import_limit_w: 20000,
      grid_export_limit_w: 20000,
      grid_import_shaping_w: 0,
      peak_shaping_sek_per_kwh_per_kw: 0,
    },
    { power_w: {}, discharge_w: {} },
  );
  assertAlmostEquals(r.objective.billable_sek, old.billable_sek);
});

Deno.test("physical violations retain unclamped state and never become an economic score", () => {
  const p = problem();
  const c = cycle(p);
  const b = p.plant.equipment[0];
  assert(b.kind === "battery");
  b.state_kwh.max = 2.5;
  const r = infeasible(
    createHouseholdScorer(p).score(c),
    "outside physical bounds",
  );
  assertEquals(r.trajectory.state.battery[1], 3);
  p.economics.import_sek_per_kwh.fill(0);
  p.economics.export_sek_per_kwh.fill(0);
  assertEquals(
    infeasible(createHouseholdScorer(p).score(c), "outside physical bounds")
      .violations,
    r.violations,
  );
});

Deno.test("grid charging and export require explicit conserved source allocations", () => {
  const p = problem();
  const c = cycle(p);
  const b = p.plant.equipment[0];
  assert(b.kind === "battery");
  b.grid_charge_allowed.fill(false);
  infeasible(createHouseholdScorer(p).score(c), "grid charging not permitted");
  const a = c.actions.battery[0];
  assert(a.kind === "battery");
  a.solar_charge_w = 4000;
  infeasible(createHouseholdScorer(p).score(c), "solar charging exceeds");
  p.plant.pv_w[0] = 5000;
  scored(createHouseholdScorer(p).score(c));
  b.export_allowed[1] = false;
  infeasible(createHouseholdScorer(p).score(c), "export not permitted");
});

Deno.test("two batteries cannot each claim the same solar or send undeclared export", () => {
  const p = problem(1);
  p.plant.pv_w[0] = 4000;
  p.plant.equipment = [battery(1), { ...battery(1), id: "second" }];
  const c = idle(p);
  for (const id of ["battery", "second"]) {
    c.actions[id][0] = {
      kind: "battery",
      charge_w: 4000,
      solar_charge_w: 4000,
      discharge_w: 0,
      export_w: 0,
    };
  }
  infeasible(createHouseholdScorer(p).score(c), "solar charging exceeds");
  p.plant.pv_w[0] = 0;
  c.actions.battery[0] = {
    kind: "battery",
    charge_w: 0,
    solar_charge_w: 0,
    discharge_w: 4000,
    export_w: 0,
  };
  c.actions.second[0] = {
    kind: "battery",
    charge_w: 0,
    solar_charge_w: 0,
    discharge_w: 0,
    export_w: 0,
  };
  infeasible(createHouseholdScorer(p).score(c), "unattributed battery export");
});

Deno.test("explicit curtailment is required when export exceeds the physical limit", () => {
  const p = problem(1);
  p.plant.pv_w[0] = 6000;
  p.plant.grid.export_limit_w = 2000;
  const c = idle(p);
  infeasible(createHouseholdScorer(p).score(c), "grid export limit");
  c.pv_curtail_w[0] = 3000;
  assertEquals(
    scored(createHouseholdScorer(p).score(c)).trajectory.intervals[0].export_w,
    2000,
  );
  c.pv_curtail_w[0] = 6001;
  infeasible(createHouseholdScorer(p).score(c), "curtailment exceeds");
});

Deno.test("shared heater routes heat once and does not pay a new start on route change", () => {
  const p = problem();
  addThermal(p, "pool");
  addThermal(p, "tank");
  p.plant.equipment.push(heater(p, ["pool", "tank"]));
  const c = idle(p);
  c.actions.heater = ["pool", "tank", null, "pool"].map((store_id) => ({
    kind: "heater",
    store_id,
    power_w: store_id ? 1000 : 0,
  }));
  const r = scored(createHouseholdScorer(p).score(c));
  assertEquals(r.trajectory.intervals[0].heat_w, { pool: 3000, tank: 0 });
  assertAlmostEquals(r.trajectory.state.pool.at(-1)!, 21.5);
  assertAlmostEquals(r.trajectory.state.tank.at(-1)!, 20.75);
  assertAlmostEquals(r.objective.starts_sek, 1);
  assertAlmostEquals(r.objective.import_sek, (1 + 1.1 * 0.75) * 2);
  const h = p.plant.equipment[0];
  assert(h.kind === "heater");
  h.initially_running = true;
  assertAlmostEquals(
    scored(createHouseholdScorer(p).score(c)).objective.starts_sek,
    0.5,
  );
  h.available[1] = false;
  infeasible(createHouseholdScorer(p).score(c), "heater unavailable");
});

Deno.test("multiple independent heaters may supply one store without duplicating its utility", () => {
  const p = problem(1);
  addThermal(p, "room");
  p.plant.equipment = [heater(p, ["room"]), {
    ...heater(p, ["room"]),
    id: "second",
  }];
  p.economics.services = [{
    id: "warmth",
    kind: "continuous",
    store_id: "room",
    curves: [curve("celsius", 1)],
  }];
  const c = idle(p);
  c.actions.heater[0] = { kind: "heater", store_id: "room", power_w: 1000 };
  c.actions.second[0] = { kind: "heater", store_id: "room", power_w: 1000 };
  const r = scored(createHouseholdScorer(p).score(c));
  assertAlmostEquals(r.trajectory.state.room.at(-1)!, 21.5);
  assertAlmostEquals(r.objective.service_sek, (20 + 21.5) / 2 * 0.25);
});

Deno.test("continuous utility integrates curve knees and is invariant to splitting a linear path", () => {
  const p = problem(1);
  addThermal(p, "room", 0);
  p.plant.thermal_stores[0].background_kw = [16];
  const c = {
    unit: "celsius" as const,
    points: [{ at: 0, sek_per_unit: 4 }, { at: 4, sek_per_unit: 0 }],
  };
  p.economics.services = [{
    id: "warmth",
    kind: "continuous",
    store_id: "room",
    curves: [c],
  }];
  const one = scored(createHouseholdScorer(p).score(idle(p)));
  // U(T)=4T-T²/2; mean U over T=0..4 is 16/3, not the endpoint average 4.
  assertAlmostEquals(one.objective.service_sek, 4 / 3);
  const split = problem(2);
  split.intervals = [{ start: stamp(0), end: stamp(7.5) }, {
    start: stamp(7.5),
    end: stamp(15),
  }];
  addThermal(split, "room", 0);
  split.plant.thermal_stores[0].background_kw = [16, 16];
  split.economics.services = [{
    id: "warmth",
    kind: "continuous",
    store_id: "room",
    curves: [c, c],
  }];
  assertAlmostEquals(
    scored(createHouseholdScorer(split).score(idle(split))).objective
      .service_sek,
    one.objective.service_sek,
  );
});

Deno.test("curve-valued room recovery may buy more grid energy without a nominal quota", () => {
  const p = problem();
  addThermal(p, "room");
  p.plant.thermal_stores[0].loss_kw_per_c = 0.2;
  const h = heater(p, ["room"]);
  assert(h.kind === "heater");
  h.technology = "resistive";
  h.start_cost_sek = 0;
  h.routes[0].cop.fill(1);
  h.routes[0].auxiliary_w = 0;
  p.plant.equipment = [h];
  p.economics.services = [{
    id: "warmth",
    kind: "continuous",
    store_id: "room",
    curves: Array(4).fill(curve("celsius", 10)),
  }];
  const off = idle(p), heat = idle(p);
  heat.actions.heater.fill({ kind: "heater", store_id: "room", power_w: 2000 });
  const scorer = createHouseholdScorer(p),
    a = scored(scorer.score(off)),
    b = scored(scorer.score(heat));
  assert(b.objective.billable_sek > a.objective.billable_sek);
  assert(b.objective.total_sek < a.objective.total_sek);
  assertEquals(b.objective.starts_sek, 0);
  p.plant.grid.import_limit_w = 2500;
  infeasible(createHouseholdScorer(p).score(heat), "grid import limit");
});

Deno.test("EV readiness is anchored, graded and conditional on declared connection", () => {
  const p = problem();
  p.plant.equipment = [ev()];
  p.economics.services = [{
    id: "departure",
    kind: "event",
    store_id: "ev",
    at: stamp(60),
    curve: {
      unit: "kwh",
      points: [{ at: 30, sek_per_unit: 5 }, { at: 38, sek_per_unit: 0.2 }, {
        at: 40,
        sek_per_unit: 0,
      }],
    },
  }];
  const values: number[] = [];
  for (const initial of [30, 38, 39, 40]) {
    const e = p.plant.equipment[0];
    assert(e.kind === "ev");
    e.state_kwh.initial = initial;
    const r = scored(createHouseholdScorer(p).score(idle(p)));
    values.push(r.objective.service_sek);
    assertEquals(r.intervals.map((v) => v.objective.service_sek), [0, 0, 0, 0]);
    assertEquals(r.objective.service_sek, r.closing.service_sek);
  }
  assert(values[1] - values[0] > 10 * (values[3] - values[1]));
  assert(values[3] > values[2] && values[2] > values[1]);
  const e = p.plant.equipment[0];
  assert(e.kind === "ev");
  e.state_kwh.initial = 38;
  e.connected[0] = false;
  const c = idle(p);
  c.actions.ev[0] = { kind: "ev", current_a: 5 };
  infeasible(createHouseholdScorer(p).score(c), "disconnected");
  c.actions.ev[0] = { kind: "ev", current_a: 6 };
  infeasible(createHouseholdScorer(p).score(c), "unsupported EV current");
  assert(p.economics.services[0].kind === "event");
  assertEquals(p.economics.services[0].at, stamp(60));
});

Deno.test("replanning preserves event date, completion and closing ownership", () => {
  const p = problem();
  p.plant.equipment = [ev()];
  p.economics.services = [{
    id: "departure",
    kind: "event",
    store_id: "ev",
    at: stamp(0),
    curve: curve("kwh", 1),
  }];
  const r = scored(createHouseholdScorer(p).score(idle(p)));
  assertEquals(r.intervals[0].objective.service_sek, 38);
  p.economics.completed_event_ids = ["departure"];
  assertEquals(
    scored(createHouseholdScorer(p).score(idle(p))).objective.service_sek,
    0,
  );
  p.intervals = p.intervals.map((_, i) => ({
    start: stamp(15 + i * 15),
    end: stamp(30 + i * 15),
  }));
  p.identity.actuals_watermark = stamp(15);
  assertEquals(
    scored(createHouseholdScorer(p).score(idle(p))).objective.service_sek,
    0,
  );
  p.economics.completed_event_ids = [];
  assertThrows(() => createHouseholdScorer(p), Error, "past event");
});

Deno.test("terminal coverage cannot duplicate an in-horizon event or another terminal claim", () => {
  const p = problem();
  p.plant.equipment = [ev()];
  p.economics.services = [{
    id: "departure",
    kind: "event",
    store_id: "ev",
    at: stamp(60),
    curve: curve("kwh", 1),
  }];
  p.economics.terminal = [{
    id: "future",
    store_id: "ev",
    curve: curve("kwh", 1),
    coverage_from: stamp(60),
    model_id: "tail",
    event_ids: ["departure"],
  }];
  assertThrows(() => createHouseholdScorer(p), Error, "incompatible event");
  assert(p.economics.services[0].kind === "event");
  p.economics.services[0].at = stamp(120);
  const r = scored(createHouseholdScorer(p).score(idle(p)));
  assertEquals(r.objective.service_sek, 0);
  assertEquals(r.objective.terminal_sek, 38);
  p.economics.terminal.push({ ...p.economics.terminal[0], id: "double" });
  assertThrows(() => createHouseholdScorer(p), Error, "duplicate");
});

Deno.test("sunny then cloudy pool preheat can beat later purchases after heat loss", () => {
  const p = problem();
  addThermal(p, "pool");
  p.plant.thermal_stores[0].loss_kw_per_c = 0.1;
  p.plant.thermal_stores[0].environment_c.fill(20);
  p.plant.pv_w = [2100, 0, 0, 0];
  p.economics.export_sek_per_kwh.fill(0);
  p.plant.equipment = [heater(p, ["pool"])];
  p.economics.services = [{
    id: "swim",
    kind: "event",
    store_id: "pool",
    at: stamp(60),
    curve: curve("celsius", 0.2),
  }];
  const early = idle(p), late = idle(p);
  early.actions.heater[0] = { kind: "heater", store_id: "pool", power_w: 1000 };
  late.actions.heater[3] = { kind: "heater", store_id: "pool", power_w: 1000 };
  const scorer = createHouseholdScorer(p),
    a = scored(scorer.score(early)),
    b = scored(scorer.score(late));
  assert(a.trajectory.state.pool.at(-1)! < b.trajectory.state.pool.at(-1)!);
  assert(a.objective.total_sek < b.objective.total_sek);
});

Deno.test("partial interval and gross subquarter flows retain costs hidden by average net energy", () => {
  const p = problem(2);
  p.intervals = [{ start: stamp(5), end: stamp(10) }, {
    start: stamp(10),
    end: stamp(15),
  }];
  p.identity.actuals_watermark = stamp(5);
  p.plant.residual_loads[0].power_w = [2000, 2000];
  p.plant.pv_w = [4000, 0];
  const r = scored(createHouseholdScorer(p).score(idle(p)));
  assertAlmostEquals(r.objective.import_sek, 1 / 3);
  assertAlmostEquals(r.objective.export_sek, 1 / 6);
  assertAlmostEquals(r.objective.billable_sek, 1 / 6); // net energy is zero, bill is not
});

Deno.test("negative prices, shaping and ramp remain finite and separately reported", () => {
  const p = problem(1);
  p.economics.import_sek_per_kwh[0] = -2;
  p.economics.shaping_sek_per_kwh_per_kw = 2;
  p.economics.ramp_sek_per_kw = 0.3;
  p.economics.initial_import_w = 0;
  const r = scored(createHouseholdScorer(p).score(idle(p)));
  assertAlmostEquals(r.objective.billable_sek, -0.5);
  assertAlmostEquals(r.objective.shaping_sek, 0.25);
  assertAlmostEquals(r.objective.ramp_sek, 0.3);
  assertAlmostEquals(r.objective.total_sek, 0.05);
});

Deno.test("strict boundary rejects incomplete, unknown, nonfinite and misleading models", () => {
  const p = problem();
  p.plant.equipment = [battery()];
  const scorer = createHouseholdScorer(p), c = idle(p);
  delete c.actions.battery;
  assertEquals(scorer.score(c).status, "invalid_candidate");
  assertEquals(
    scorer.score({ ...idle(p), feasible: true }).status,
    "invalid_candidate",
  );
  c.actions.battery = [{
    kind: "battery",
    charge_w: NaN,
    discharge_w: 0,
    solar_charge_w: 0,
    export_w: 0,
  }];
  assertEquals(scorer.score(c).status, "invalid_candidate");
  assertThrows(() => createHouseholdScorer({ ...p, minimum_on_seconds: 60 }));
  assertThrows(() => createHouseholdScorer({ ...p, schema_version: 8 }));
  p.plant.pv_w.pop();
  assertThrows(() => createHouseholdScorer(p), Error, "exactly");
  p.plant.pv_w.push(0);
  p.plant.residual_loads[0].id = "battery";
  assertThrows(() => createHouseholdScorer(p), Error, "duplicate");
});

Deno.test("schema rejects parallel shared routes, wrong units and gap/overlap", () => {
  const p = problem();
  addThermal(p, "pool");
  p.plant.equipment = [heater(p, ["pool"])];
  const c = idle(p);
  const bad = {
    ...c,
    actions: {
      heater: Array(4).fill({
        kind: "heater",
        store_id: ["pool", "tank"],
        power_w: 1000,
      }),
    },
  };
  assertEquals(createHouseholdScorer(p).score(bad).status, "invalid_candidate");
  p.economics.services = [{
    id: "warmth",
    kind: "continuous",
    store_id: "pool",
    curves: Array(4).fill(curve("kwh", 1)),
  }];
  assertThrows(() => createHouseholdScorer(p), Error, "wrong curve unit");
  p.economics.services = [];
  p.intervals[1].start = stamp(16);
  assertThrows(() => createHouseholdScorer(p), Error, "gap/overlap");
});

Deno.test("owned problem and per-call results cannot mutate later evaluations", () => {
  const p = problem();
  p.plant.equipment = [ev()];
  const c = idle(p);
  const before = JSON.stringify({ p, c });
  const scorer = createHouseholdScorer(p);
  const a = scored(scorer.score(c));
  a.trajectory.state.ev[0] = 999;
  assertEquals(JSON.stringify({ p, c }), before);
  p.economics.import_sek_per_kwh.fill(1000);
  const b = scored(scorer.score(c));
  assertEquals(b.trajectory.state.ev[0], 38);
  assertEquals(b.objective.billable_sek, 2);
});

Deno.test("bundled resolved case is runnable and recovery improves whole-household objective", async () => {
  const file = new URL(
    "../../../docs/energy-optimisation/fixtures/household-scorer/grid-recovery.json",
    import.meta.url,
  );
  const input = JSON.parse(await Deno.readTextFile(file));
  const scorer = createHouseholdScorer(input.problem);
  const results = input.candidates.map((c: unknown) => scored(scorer.score(c)));
  assertEquals(results.length, 2);
  assert(results[1].objective.total_sek < results[0].objective.total_sek);
});

Deno.test("72-hour household retains thermal state and event identity across day boundaries", () => {
  const p = problem(288);
  addThermal(p, "pool", 28);
  const pool = p.plant.thermal_stores[0];
  pool.role = "pool";
  pool.capacity_kwh_per_c = 50;
  pool.loss_kw_per_c = 0.05;
  pool.environment_c.fill(20);
  p.plant.pv_w = p.intervals.map((_, i) => i >= 16 && i < 64 ? 5000 : 0);
  p.plant.equipment = [heater(p, ["pool"])];
  p.economics.export_sek_per_kwh.fill(0);
  p.economics.services = [{
    id: "tomorrow-swim",
    kind: "event",
    store_id: "pool",
    at: stamp(36 * 60),
    curve: curve("celsius", 10),
  }];
  const early = idle(p), late = idle(p);
  for (let i = 32; i < 48; i++) {
    early.actions.heater[i] = {
      kind: "heater",
      store_id: "pool",
      power_w: 1000,
    };
  }
  for (let i = 128; i < 144; i++) {
    late.actions.heater[i] = {
      kind: "heater",
      store_id: "pool",
      power_w: 1000,
    };
  }
  const scorer = createHouseholdScorer(p);
  const a = scored(scorer.score(early)), b = scored(scorer.score(late));
  assertEquals(a.trajectory.state.pool.length, 289);
  assertEquals(a.identity.actuals_watermark, stamp(0));
  assertEquals(
    a.intervals.filter((v) => v.objective.service_sek !== 0).length,
    1,
  );
  assertEquals(
    a.intervals[144].objective.service_sek,
    a.service_values["tomorrow-swim"],
  );
  assert(a.objective.total_sek < b.objective.total_sek);
  assertEquals(scorer.score(early), a);
});
