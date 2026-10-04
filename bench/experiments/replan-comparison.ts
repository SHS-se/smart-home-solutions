/** Offline steady-device experiment; not the production solver. */
import { realisticWorld } from "../../src/lib/planner-bench/world.fixture.ts";
import { HOUSEHOLD } from "../../src/lib/planner-bench/household.ts";
import { snapshotFor } from "../adapter.ts";
import {
  dispatchWorkbenchInputs,
  type OptimisationSnapshot,
} from "../../supabase/functions/_shared/planner/energy-optimisation.ts";
import {
  type DispatchSlot,
  type DispatchStore,
  scoreDispatch,
} from "../../supabase/functions/_shared/planner/dispatch-plan.ts";
import { valueOfMove } from "../../supabase/functions/_shared/planner/store-value.ts";
import {
  prepareReplanStart,
  type ReplanProblem,
  type SelectedEstimates,
  STORE_KEYS,
  type StoreKey,
} from "./replan-seed.ts";

const NODES = 97, BEAM = 4;
interface Model {
  store: DispatchStore;
  grid: number[];
  commands: number[];
  memories: number;
  token: string;
}
interface Problem {
  seed: ReplanProblem;
  slots: DispatchSlot[];
  starts: number[];
  limits: NonNullable<ReturnType<typeof dispatchWorkbenchInputs>>["limits"];
  models: Record<StoreKey, Model>;
}
type Profile = Record<StoreKey, number[]>;
interface Result {
  selected: SelectedEstimates;
  profile: Profile;
  score: number;
  ms: number;
  rounds: number;
  transitions: number;
  jointActions: number;
  reuse: {
    stores: ReturnType<typeof prepareReplanStart>["stores"];
    priceReason: ReturnType<typeof prepareReplanStart>["priceReason"];
    priceRowsReused: number;
  };
}
const profile = (): Profile => ({ battery: [], ev: [], pool: [] });
const utility = (m: Model, state: number) =>
  valueOfMove(m.store.curve, 0, state);
function model(store: DispatchStore): Model {
  const low = store.min_state ?? 0,
    high = Math.max(store.initial_state, store.max_state!);
  const grid = Array.from(
    { length: NODES },
    (_, k) => low + (high - low) * k / (NODES - 1),
  );
  const commands = [0];
  if (store.min_power_w === store.max_power_w) commands.push(store.max_power_w);
  else if (store.power_step_w) {
    for (
      let w = store.min_power_w!;
      w <= store.max_power_w;
      w += store.power_step_w
    ) commands.push(w);
  } else for (let k = 1; k <= 8; k++) commands.push(store.max_power_w * k / 8);
  if (store.discharge) {
    for (let k = 1; k <= 8; k++) {
      commands.push(-store.discharge.max_power_w * k / 8);
    }
  }
  return {
    store,
    grid,
    commands,
    memories: store.start_cost_sek ? 2 : 1,
    token: JSON.stringify({
      physics:
        HOUSEHOLD[store.key === "ev" ? "car" : store.key as "pool" | "battery"],
      powers: commands,
      bounds: [store.min_state, store.max_state],
    }),
  };
}
export function resolve(
  snapshot: OptimisationSnapshot,
  stableUtility?: Record<StoreKey, DispatchStore["curve"]>,
): Problem {
  const inputs = dispatchWorkbenchInputs(snapshot)!;
  const find = (key: StoreKey) => {
    const original = inputs.stores.find((store) => store.key === key)!;
    // Each comparison has one immutable evaluator. Price edits do not retune utility.
    return model({
      ...original,
      curve: stableUtility?.[key] ?? original.curve,
    });
  };
  const models = {
    battery: find("battery"),
    ev: find("ev"),
    pool: find("pool"),
  };
  const initial = (key: StoreKey) => {
    const m = models[key];
    return {
      layout: JSON.stringify({ grid: m.grid, memories: m.memories }),
      model: m.token,
      economics: JSON.stringify({
        curve: m.store.curve,
        terminal: m.store.terminal_weight,
        usage: m.store.usage_weight,
      }),
      rows: inputs.slots.map(() =>
        Array.from(
          { length: NODES * m.memories },
          (_, k) =>
            (m.store.terminal_weight ?? 0) * utility(m, m.grid[k % NODES]),
        )
      ),
    };
  };
  return {
    slots: inputs.slots,
    starts: inputs.slot_start_ms,
    limits: inputs.limits,
    models,
    seed: {
      home: "synthetic-household",
      algorithm: "steady-replan-prototype-v1",
      resources: JSON.stringify(inputs.limits),
      quarters: inputs.slots.map((slot, t) => ({
        start: new Date(inputs.slot_start_ms[t]).toISOString(),
        hours: slot.duration_hours ?? .25,
        basePrice: slot.fixed_load_w >= slot.pv_w
          ? slot.import_price_sek_per_kwh
          : slot.export_price_sek_per_kwh,
        importPrice: slot.import_price_sek_per_kwh,
        exportPrice: slot.export_price_sek_per_kwh,
      })),
      stores: {
        battery: initial("battery"),
        ev: initial("ev"),
        pool: initial("pool"),
      },
    },
  };
}
function transition(
  m: Model,
  state: number,
  command: number,
  t: number,
  hours: number,
): number | null {
  const store = m.store;
  const next = store.drift(state, t) +
    command / 1000 * hours *
      (command >= 0
        ? store.units_per_kwh(state, t)
        : store.discharge!.state_per_kwh_out(state, t));
  if (command > 0 && next > (store.max_state ?? Infinity) + 1e-8) return null;
  if (command < 0 && next < (store.min_state ?? -Infinity) - 1e-8) return null;
  return next >= m.grid[0] - 1e-8 && next <= m.grid.at(-1)! + 1e-8
    ? next
    : null;
}
function interpolate(
  m: Model,
  row: number[],
  state: number,
  memory: number,
): number {
  const x = Math.max(
      0,
      Math.min(NODES - 1, (state - m.grid[0]) / (m.grid[1] - m.grid[0])),
    ),
    lo = Math.min(NODES - 2, Math.floor(x)),
    f = x - lo,
    offset = memory * NODES;
  return row[offset + lo] * (1 - f) + row[offset + lo + 1] * f;
}
const wear = (m: Model, state: number, w: number, t: number, hours: number) =>
  Math.abs(w) / 1000 * hours * (m.store.wear_sek_per_kwh ?? 0) +
  (w < 0
    ? -w / 1000 * hours * m.store.discharge!.state_per_kwh_out(state, t) *
      (m.store.discharge!.cycling_cost_sek_per_unit ?? 0)
    : 0);
const starts = (p: Problem, m: Model, memory: number, w: number) =>
  memory === 0 && w > 0
    ? (m.store.start_cost_sek ?? 0) +
      (m.store.start_cost_sek ? p.limits.load_start_preference_sek ?? 0 : 0)
    : 0;
const service = (m: Model, state: number, t: number) =>
  (m.store.usage_weight[t] ?? 0) * utility(m, state);
function q(
  p: Problem,
  m: Model,
  row: number[],
  state: number,
  memory: number,
  w: number,
  t: number,
  price: number,
): number {
  const h = p.slots[t].duration_hours ?? .25,
    next = transition(m, state, w, t, h);
  if (next === null) return -Infinity;
  return service(m, state, t) - price * w / 1000 * h - wear(m, state, w, t, h) -
    starts(p, m, memory, w) +
    interpolate(m, row, next, m.memories === 2 && w > 0 ? 1 : 0);
}
function bellman(
  p: Problem,
  key: StoreKey,
  prices: number[],
  rows: number[][],
): { tables: number[][]; transitions: number } {
  const m = p.models[key], tables = rows;
  // The CURRENT terminal boundary is always freshly computed. A full backward
  // sweep overwrites every seed row; prior rows are not a new economic policy.
  tables.push(
    Array.from(
      { length: NODES * m.memories },
      (_, k) => (m.store.terminal_weight ?? 0) * utility(m, m.grid[k % NODES]),
    ),
  );
  let count = 0;
  for (let t = p.slots.length - 1; t >= 0; t--) {
    for (let mem = 0; mem < m.memories; mem++) {
      for (let k = 0; k < NODES; k++) {
        let best = -Infinity;
        for (const w of m.commands) {
          count++;
          best = Math.max(
            best,
            q(p, m, tables[t + 1], m.grid[k], mem, w, t, prices[t]),
          );
        }
        if (!Number.isFinite(best)) {
          throw new Error("Prototype lattice has no represented action");
        }
        tables[t][mem * NODES + k] = best;
      }
    }
  }
  return { tables, transitions: count };
}
interface Trajectory {
  state: Record<StoreKey, number>;
  memory: Record<StoreKey, number>;
  commands: Profile;
  value: number;
  rank: number;
  previousImport: number;
}
function rollout(
  p: Problem,
  tables: Record<StoreKey, number[][]>,
  prices: number[],
): { commands: Profile; actions: number } {
  let beam: Trajectory[] = [{
    state: {
      battery: p.models.battery.store.initial_state,
      ev: p.models.ev.store.initial_state,
      pool: p.models.pool.store.initial_state,
    },
    memory: {
      battery: 0,
      ev: 0,
      pool: p.models.pool.store.initially_charging ? 1 : 0,
    },
    commands: profile(),
    value: 0,
    rank: 0,
    previousImport: 0,
  }];
  let actions = 0;
  for (let t = 0; t < p.slots.length; t++) {
    const slot = p.slots[t],
      h = slot.duration_hours ?? .25,
      successors: Trajectory[] = [];
    for (const prior of beam) {
      const choices = (key: StoreKey) => {
        const m = p.models[key];
        const sorted = m.commands.filter((w) =>
          transition(m, prior.state[key], w, t, h) !== null
        )
          .sort((a, b) =>
            q(
              p,
              m,
              tables[key][t + 1],
              prior.state[key],
              prior.memory[key],
              b,
              t,
              prices[t],
            ) -
            q(
              p,
              m,
              tables[key][t + 1],
              prior.state[key],
              prior.memory[key],
              a,
              t,
              prices[t],
            )
          );
        return [...new Set([0, ...sorted.slice(0, 2)])];
      };
      for (const battery of choices("battery")) {
        for (const ev of choices("ev")) {
          for (const pool of choices("pool")) {
            actions++;
            const w = { battery, ev, pool },
              state = { ...prior.state },
              memory = { ...prior.memory };
            let valid = true, stageValue = 0;
            for (const key of STORE_KEYS) {
              const m = p.models[key],
                next = transition(m, prior.state[key], w[key], t, h);
              if (next === null) {
                valid = false;
                break;
              }
              state[key] = next;
              memory[key] = m.memories === 2 && w[key] > 0 ? 1 : 0;
              stageValue += service(m, prior.state[key], t) -
                wear(m, prior.state[key], w[key], t, h) -
                starts(p, m, prior.memory[key], w[key]);
            }
            if (!valid) {
              continue;
            }
            const net = slot.fixed_load_w - slot.pv_w + battery + ev + pool,
              imported = Math.max(0, net),
              exported = Math.min(
                p.limits.grid_export_limit_w,
                Math.max(0, -net),
              );
            if (imported > p.limits.grid_import_limit_w + 1e-6) continue;
            const discharge = p.models.battery.store.discharge!;
            if (
              battery < 0 && exported > 1 &&
              (!discharge.export_allowed ||
                discharge.export_allowed_by_slot?.[t] === false ||
                state.battery < (discharge.export_min_state ?? -Infinity))
            ) continue;
            stageValue -= h / 1000 *
              (imported * slot.import_price_sek_per_kwh -
                exported * slot.export_price_sek_per_kwh);
            const overKw = Math.max(
              0,
              imported - (p.limits.grid_import_shaping_w ?? Infinity),
            ) / 1000;
            stageValue -= imported / 1000 * h * overKw *
              (p.limits.peak_shaping_sek_per_kwh_per_kw ?? 0);
            if (t > 0) {
              stageValue -= Math.abs(imported - prior.previousImport) / 1000 *
                (p.limits.grid_ramp_sek_per_kw ?? 0);
            }
            const commands = {
              battery: [...prior.commands.battery, battery],
              ev: [...prior.commands.ev, ev],
              pool: [...prior.commands.pool, pool],
            };
            const value = prior.value + stageValue;
            const tail = STORE_KEYS.reduce((sum, key) =>
              sum +
              interpolate(
                p.models[key],
                tables[key][t + 1],
                state[key],
                memory[key],
              ), 0);
            successors.push({
              state,
              memory,
              commands,
              value,
              rank: value + tail,
              previousImport: imported,
            });
          }
        }
      }
    }
    successors.sort((a, b) => b.rank - a.rank);
    beam = successors.slice(0, BEAM);
    if (!beam.length) {
      throw new Error("Prototype joint rollout exhausted its candidates");
    }
  }
  return { commands: beam[0].commands, actions };
}
function rescore(p: Problem, commands: Profile) {
  const power_w = profile(), discharge_w = profile();
  for (const key of STORE_KEYS) {
    power_w[key] = commands[key].map((w) => Math.max(0, w));
    discharge_w[key] = commands[key].map((w) => Math.max(0, -w));
  }
  const score = scoreDispatch(
    p.slots,
    STORE_KEYS.map((key) => p.models[key].store),
    p.limits,
    { power_w, discharge_w },
  );
  if (score.infeasibilities.length) {
    throw new Error(
      `Prototype physical replay failed: ${
        score.infeasibilities.map((issue) => issue.message).join(", ")
      }`,
    );
  }
  return score;
}
function coordinate(
  p: Problem,
  tables: Record<StoreKey, number[][]>,
  prices: number[],
  commands: Profile,
): number[] {
  const preferred = profile();
  for (const key of STORE_KEYS) {
    const m = p.models[key];
    let state = m.store.initial_state, mem = m.store.initially_charging ? 1 : 0;
    for (let t = 0; t < p.slots.length; t++) {
      const w = [...m.commands].sort((a, b) =>
        q(p, m, tables[key][t + 1], state, mem, b, t, prices[t]) -
        q(p, m, tables[key][t + 1], state, mem, a, t, prices[t])
      )[0];
      preferred[key].push(w);
      state = transition(m, state, w, t, p.slots[t].duration_hours ?? .25)!;
      mem = m.memories === 2 && w > 0 ? 1 : 0;
    }
  }
  return p.slots.map((slot, t) => {
    const net = slot.fixed_load_w - slot.pv_w +
      STORE_KEYS.reduce((sum, key) => sum + commands[key][t], 0);
    const demand = slot.fixed_load_w - slot.pv_w +
      STORE_KEYS.reduce((sum, key) => sum + preferred[key][t], 0);
    const scarcity = .6 * Math.max(0, demand - p.limits.grid_import_limit_w) /
      p.limits.grid_import_limit_w;
    const target = (net >= 0
      ? slot.import_price_sek_per_kwh
      : slot.export_price_sek_per_kwh) + scarcity;
    return .5 * prices[t] + .5 * target;
  });
}
export function solve(
  p: Problem,
  previous: SelectedEstimates | null,
  cap: number,
): Result {
  const began = performance.now(), seed = prepareReplanStart(p.seed, previous);
  let prices = seed.prices,
    selected: SelectedEstimates | null = null,
    best = Infinity,
    bestProfile = profile(),
    transitions = 0,
    jointActions = 0,
    completed = 0;
  let rows = seed.values, lastProfile = "";
  for (let round = 1; round <= cap; round++) {
    const b = bellman(p, "battery", prices, rows.battery),
      e = bellman(p, "ev", prices, rows.ev),
      h = bellman(p, "pool", prices, rows.pool);
    transitions += b.transitions + e.transitions + h.transitions;
    const tables = { battery: b.tables, ev: e.tables, pool: h.tables };
    const trial = rollout(p, tables, prices);
    jointActions += trial.actions;
    const score = rescore(p, trial.commands).total_sek;
    if (score < best - 1e-9) {
      best = score;
      bestProfile = trial.commands;
      const owned = (key: StoreKey) => ({
        ...p.seed.stores[key],
        rows: tables[key].slice(0, -1).map((row) => [...row]),
      });
      selected = {
        ...p.seed,
        selectedRound: round,
        prices: [...prices],
        stores: {
          battery: owned("battery"),
          ev: owned("ev"),
          pool: owned("pool"),
        },
      };
    }
    completed = round;
    const nextPrices = coordinate(p, tables, prices, trial.commands),
      trace = JSON.stringify(trial.commands);
    const converged = trace === lastProfile &&
      nextPrices.every((price, t) => Math.abs(price - prices[t]) < .005);
    prices = nextPrices;
    lastProfile = trace;
    rows = {
      battery: tables.battery.slice(0, -1),
      ev: tables.ev.slice(0, -1),
      pool: tables.pool.slice(0, -1),
    };
    if (converged) break;
  }
  if (!selected) throw new Error("No complete validated candidate");
  return {
    selected,
    profile: bestProfile,
    score: best,
    ms: performance.now() - began,
    rounds: completed,
    transitions,
    jointActions,
    reuse: {
      stores: seed.stores,
      priceReason: seed.priceReason,
      priceRowsReused: seed.priceRowsReused,
    },
  };
}

if (import.meta.main) {
  const c = realisticWorld(),
    first = snapshotFor(
      c,
      HOUSEHOLD,
      1,
      true,
      false,
      false,
      true,
    ) as unknown as OptimisationSnapshot;
  const initialProblem = resolve(first);
  const fixed = {
    battery: initialProblem.models.battery.store.curve,
    ev: initialProblem.models.ev.store.curve,
    pool: initialProblem.models.pool.store.curve,
  };
  const initial = solve(initialProblem, null, 8);
  console.log(JSON.stringify({
    case: "initial",
    ms: initial.ms,
    rounds: initial.rounds,
    selectedRound: initial.selected.selectedRound,
    score: initial.score,
    transitions: initial.transitions,
    jointActions: initial.jointActions,
  }));
  for (
    const name of [
      "unchanged",
      "shifted-quarter",
      "price-change",
      "forecast-change",
      "comfort-change",
    ] as const
  ) {
    const next = structuredClone(first);
    if (name === "shifted-quarter") {
      next.captured_at = new Date(Date.parse(first.captured_at) + 900000)
        .toISOString();
      next.slots = [...next.slots.slice(1), {
        ...next.slots.at(-1)!,
        start: new Date(Date.parse(next.slots.at(-1)!.start) + 900000)
          .toISOString(),
      }];
    }
    if (name === "price-change") {
      next.slots = next.slots.map((slot, i) => ({
        ...slot,
        import_price_sek_per_kwh: slot.import_price_sek_per_kwh === null
          ? null
          : slot.import_price_sek_per_kwh + (i % 96 >= 68 ? 1 : -.2),
      }));
    }
    if (name === "forecast-change") {
      next.slots = next.slots.map((slot) => ({
        ...slot,
        pv_forecast_w: slot.pv_forecast_w * .25,
        base_load_forecast_w: slot.base_load_forecast_w + 600,
      }));
    }
    if (name === "comfort-change") next.comfort!.pool!.target_c += .5;
    const problem = resolve(
      next,
      name === "comfort-change" ? undefined : fixed,
    );
    for (const rounds of Deno.args.includes("--reference") ? [40] : [8, 10]) {
      const cold = solve(problem, null, rounds),
        warm = solve(problem, initial.selected, rounds);
      console.log(
        JSON.stringify({
          case: name,
          cap: rounds,
          cold: {
            ms: cold.ms,
            rounds: cold.rounds,
            selectedRound: cold.selected.selectedRound,
            score: cold.score,
            transitions: cold.transitions,
            jointActions: cold.jointActions,
          },
          warm: {
            ms: warm.ms,
            rounds: warm.rounds,
            selectedRound: warm.selected.selectedRound,
            score: warm.score,
            transitions: warm.transitions,
            jointActions: warm.jointActions,
            reused: warm.reuse,
          },
          scoreDifferenceSek: warm.score - cold.score,
          sameSchedule:
            JSON.stringify(warm.profile) === JSON.stringify(cold.profile),
        }),
      );
    }
  }
}
