// Independently generated synthetic pool; no captured household inputs.
import { assertAlmostEquals, assertEquals } from "@std/assert";
import { HEAT_TAIL_QUARTERS, learnPoolOperatingPoints, type PoolDeviceQuarter } from "./operating-points.ts";

const Q = 900_000;
const T0 = Date.parse("2026-11-01T00:00:00Z");
const HEATER = "synthetic-heat-pump", PUMP = "synthetic-pump";

interface Run { at: number; quarters: number; output: number; capacity: number }
/** A ground-source heat pump whose COP depends on the pump's capacity, and
 * whose heat meter reports two quarters after the electricity. */
function world(runs: Run[], quarters = 400, { heatLag = 2, heatMeter = true } = {}) {
  const heaterKwh = new Array(quarters).fill(0), pumpKwh = new Array(quarters).fill(0), heat = new Array(quarters).fill(0);
  const output = new Array(quarters).fill(12), capacity = new Array(quarters).fill(100);
  for (const run of runs) {
    const cop = run.capacity === 100 ? 4.0 : 3.9;
    for (let i = run.at; i < run.at + run.quarters; i++) {
      // The first and last quarters are partial: start-up and shut-down dilute them.
      const share = i === run.at || i === run.at + run.quarters - 1 ? 0.5 : 1;
      heaterKwh[i] = 0.75 * share;
      pumpKwh[i] = (run.capacity === 100 ? 0.19 : 0.1025) * share;
      heat[i + heatLag] += 0.75 * share * cop;
    }
    for (let i = run.at - 4; i < run.at + run.quarters + 4; i++) { output[i] = run.output; capacity[i] = run.capacity; }
  }
  const rows: PoolDeviceQuarter[] = [];
  for (let i = 0; i < quarters; i++) {
    rows.push({ start_ms: T0 + i * Q, device_key: HEATER, energy_kwh: heaterKwh[i], power_setting: output[i], heat_kwh: heatMeter ? heat[i] : null });
    rows.push({ start_ms: T0 + i * Q, device_key: PUMP, energy_kwh: pumpKwh[i], power_setting: capacity[i], heat_kwh: null });
  }
  return { rows, to: T0 + quarters * Q };
}
const learn = (rows: PoolDeviceQuarter[], to: number, from = T0) =>
  learnPoolOperatingPoints(rows, [HEATER], [PUMP], from, to);
const at = (rows: PoolDeviceQuarter[], index: number, key: string) =>
  rows.findIndex(row => row.start_ms === T0 + index * Q && row.device_key === key);

Deno.test("each setting combination gets its own measured draw and COP", () => {
  const { rows, to } = world([
    { at: 10, quarters: 24, output: 12, capacity: 100 }, { at: 60, quarters: 28, output: 12, capacity: 100 },
    { at: 120, quarters: 24, output: 12, capacity: 80 }, { at: 170, quarters: 20, output: 8, capacity: 80 },
  ]);
  const learned = learn(rows, to);
  assertEquals(learned.points.length, 3);
  const point = (output: number, capacity: number) =>
    learned.points.find(p => p.settings[HEATER] === output && p.settings[PUMP] === capacity)!;
  assertEquals(point(12, 100).sessions, 2);
  assertEquals(point(12, 100).electric_w, { [HEATER]: 3000, [PUMP]: 760 });
  assertEquals(point(12, 80).electric_w, { [HEATER]: 3000, [PUMP]: 410 });
  assertAlmostEquals(point(12, 100).cop!, 4.0, 1e-9);
  assertAlmostEquals(point(12, 80).cop!, 3.9, 1e-9);
  assertEquals(point(12, 100).running_hours, 13);
  assertEquals([learned.unattributed_sessions, learned.unbounded_runs, learned.pending_sessions], [0, 0, 0]);
});

Deno.test("a setting change during a session belongs to no point", () => {
  const { rows, to } = world([{ at: 10, quarters: 24, output: 12, capacity: 100 }, { at: 80, quarters: 24, output: 12, capacity: 80 }]);
  rows[at(rows, 20, PUMP)].power_setting = 80; // changed by hand mid-run
  const learned = learn(rows, to);
  assertEquals(learned.unattributed_sessions, 1);
  assertEquals(learned.points.map(p => p.settings[PUMP]), [80]);
});

Deno.test("an unknown setting is not the previous one", () => {
  const { rows, to } = world([{ at: 10, quarters: 24, output: 12, capacity: 100 }]);
  rows[at(rows, 15, PUMP)].power_setting = null;
  assertEquals(learn(rows, to).unattributed_sessions, 1);
  assertEquals(learn(rows, to).points, []);
});

Deno.test("the newest session waits for its quarters and heat, and a later capture includes it", () => {
  const { rows, to } = world([{ at: 10, quarters: 24, output: 12, capacity: 100 }, { at: 360, quarters: 24, output: 12, capacity: 100 }], 400);
  // Captured while the second run's last quarters and the heat behind them are still arriving.
  const lateTo = T0 + 386 * Q;
  const late = learn(rows.filter(row => row.start_ms < lateTo), lateTo);
  assertEquals(late.pending_sessions, 1);
  assertEquals(late.points[0].sessions, 1);
  // Only the heat tail is outstanding: still pending, never counted as idle.
  const tailTo = T0 + (384 + HEAT_TAIL_QUARTERS - 1) * Q;
  assertEquals(learn(rows.filter(row => row.start_ms < tailTo), tailTo).pending_sessions, 1);
  const complete = learn(rows, to);
  assertEquals(complete.pending_sessions, 0);
  assertEquals(complete.points[0].sessions, 2);
  assertAlmostEquals(complete.points[0].cop!, 4.0, 1e-9);
});

Deno.test("a missing quarter inside a run leaves only that run out", () => {
  const { rows, to } = world([{ at: 10, quarters: 24, output: 12, capacity: 100 }, { at: 80, quarters: 24, output: 12, capacity: 100 }]);
  const holed = rows.filter((_, index) => index !== at(rows, 20, HEATER));
  const learned = learn(holed, to);
  assertEquals(learned.unbounded_runs, 2); // the two halves either side of the hole
  assertEquals(learned.points[0].sessions, 1);
  assertEquals(learned.points[0].electric_w[HEATER], 3000);
});

Deno.test("an unavailable heat meter keeps the draw and drops only that session's COP", () => {
  const { rows, to } = world([{ at: 10, quarters: 24, output: 12, capacity: 100 }, { at: 80, quarters: 24, output: 12, capacity: 100 }]);
  rows[at(rows, 90, HEATER)].heat_kwh = null;
  const point = learn(rows, to).points[0];
  assertEquals([point.sessions, point.heat_sessions], [2, 1]);
  assertAlmostEquals(point.cop!, 4.0, 1e-9);
  assertEquals(point.electric_w, { [HEATER]: 3000, [PUMP]: 760 });
});

Deno.test("an unavailable electricity counter in the heat tail is not idle time", () => {
  const { rows, to } = world([{ at: 10, quarters: 24, output: 12, capacity: 100 }, { at: 80, quarters: 24, output: 12, capacity: 100 }]);
  const missing = rows.filter((_, index) => index !== at(rows, 36, HEATER));
  const learned = learn(missing, to);
  assertEquals([learned.unbounded_runs, learned.points[0].sessions], [1, 1]);
});

Deno.test("runs closer together than the heat tail are one session", () => {
  const { rows, to } = world([{ at: 10, quarters: 12, output: 12, capacity: 100 }, { at: 25, quarters: 12, output: 12, capacity: 100 }], 120, { heatLag: 4 });
  const point = learn(rows, to).points[0];
  assertEquals([point.sessions, point.heat_sessions], [1, 1]);
  assertAlmostEquals(point.cop!, 4.0, 1e-9);
});

Deno.test("without a heat meter the draw is still learned per setting", () => {
  const { rows, to } = world([{ at: 10, quarters: 24, output: 12, capacity: 100 }, { at: 80, quarters: 24, output: 12, capacity: 80 }], 200, { heatMeter: false });
  const byCapacity = Object.fromEntries(learn(rows, to).points.map(p => [p.settings[PUMP], [p.electric_w[PUMP], p.cop, p.heat_kwh]]));
  assertEquals(byCapacity, { 100: [760, null, null], 80: [410, null, null] });
});

Deno.test("a run cut by the start of the window is not a whole session", () => {
  const { rows, to } = world([{ at: 10, quarters: 24, output: 12, capacity: 100 }, { at: 80, quarters: 24, output: 12, capacity: 100 }]);
  const learned = learn(rows, to, T0 + 20 * Q);
  assertEquals([learned.unbounded_runs, learned.points[0].sessions], [1, 1]);
});

Deno.test("no heater keys or no quarters learn nothing and never throw", () => {
  assertEquals(learnPoolOperatingPoints([], [HEATER], [PUMP], T0, T0 + Q).points, []);
  assertEquals(learnPoolOperatingPoints(world([]).rows, [], [PUMP], T0, T0 + 400 * Q).points, []);
});
