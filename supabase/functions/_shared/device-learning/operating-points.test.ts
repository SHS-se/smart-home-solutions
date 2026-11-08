// Independently generated synthetic equipment; no captured household inputs.
import { assertAlmostEquals, assertEquals } from "@std/assert";
import { HEAT_TAIL_QUARTERS, learnOperatingPoints, type DeviceQuarter } from "./operating-points.ts";

const Q = 900_000;
const T0 = Date.parse("2026-11-01T00:00:00Z");
const HEATER = "synthetic-heat-pump", PUMP = "synthetic-pump", CHARGER = "synthetic-charger";

interface Run { at: number; quarters: number; output: number; capacity: number }
/** A ground-source heat pump whose COP depends on the pump's capacity, and
 * whose heat meter reports `heatLag` quarters after the electricity. */
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
  const rows: DeviceQuarter[] = [];
  for (let i = 0; i < quarters; i++) {
    rows.push({ start_ms: T0 + i * Q, device_key: HEATER, energy_kwh: heaterKwh[i], power_setting: output[i], heat_kwh: heatMeter ? heat[i] : null });
    rows.push({ start_ms: T0 + i * Q, device_key: PUMP, energy_kwh: pumpKwh[i], power_setting: capacity[i], heat_kwh: null });
  }
  return { rows, to: T0 + quarters * Q };
}
const learn = (rows: DeviceQuarter[], to: number, from = T0) => learnOperatingPoints(rows, [HEATER], [PUMP], from, to);
const at = (rows: DeviceQuarter[], index: number, key: string) =>
  rows.findIndex(row => row.start_ms === T0 + index * Q && row.device_key === key);
const point = (learned: ReturnType<typeof learn>, output: number, capacity: number) =>
  learned.points.find(p => p.settings[HEATER] === output && p.settings[PUMP] === capacity)!;

Deno.test("each setting combination gets its own measured draw and COP", () => {
  const { rows, to } = world([
    { at: 10, quarters: 24, output: 12, capacity: 100 }, { at: 60, quarters: 28, output: 12, capacity: 100 },
    { at: 120, quarters: 24, output: 12, capacity: 80 }, { at: 170, quarters: 20, output: 8, capacity: 80 },
  ]);
  const learned = learn(rows, to);
  assertEquals(learned.points.length, 3);
  assertEquals(point(learned, 12, 100).heat_sessions, 2);
  assertEquals(point(learned, 12, 100).electric_w, { [HEATER]: 3000, [PUMP]: 760 });
  assertEquals(point(learned, 12, 80).electric_w, { [HEATER]: 3000, [PUMP]: 410 });
  assertAlmostEquals(point(learned, 12, 100).cop!, 4.0, 1e-9);
  assertAlmostEquals(point(learned, 12, 80).cop!, 3.9, 1e-9);
  assertEquals(point(learned, 12, 100).running_hours, 13);
  assertEquals(point(learned, 12, 100).steady_hours, 12);
  assertEquals([learned.unattributed_sessions, learned.unbounded_sessions, learned.pending_sessions], [0, 0, 0]);
});

Deno.test("a setting changed during a session still teaches draw on both sides, but no COP", () => {
  const { rows, to } = world([{ at: 10, quarters: 24, output: 12, capacity: 100 }]);
  for (let i = 20; i < 40; i++) rows[at(rows, i, PUMP)].power_setting = 80; // turned down by hand mid-run
  const learned = learn(rows, to);
  assertEquals(learned.unattributed_sessions, 1);
  assertEquals(point(learned, 12, 100).steady_hours, 2.25);
  assertEquals(point(learned, 12, 80).steady_hours, 3.25);
  assertEquals([point(learned, 12, 100).cop, point(learned, 12, 80).cop], [null, null]);
});

Deno.test("an unknown setting is not the previous one", () => {
  const { rows, to } = world([{ at: 10, quarters: 24, output: 12, capacity: 100 }]);
  rows[at(rows, 15, PUMP)].power_setting = null;
  const learned = learn(rows, to);
  assertEquals(learned.unattributed_sessions, 1);
  assertEquals(point(learned, 12, 100).steady_hours, 5.5 - 0.25);
  assertEquals(point(learned, 12, 100).cop, null);
});

Deno.test("the newest session waits for its quarters and heat, and a later capture includes it", () => {
  const { rows, to } = world([{ at: 10, quarters: 24, output: 12, capacity: 100 }, { at: 360, quarters: 24, output: 12, capacity: 100 }], 400);
  const lateTo = T0 + 386 * Q;
  const late = learn(rows.filter(row => row.start_ms < lateTo), lateTo);
  assertEquals(late.pending_sessions, 1);
  assertEquals(late.points[0].heat_sessions, 1);
  // Only the heat tail is outstanding: still pending, never counted as idle.
  const tailTo = T0 + (384 + HEAT_TAIL_QUARTERS - 1) * Q;
  assertEquals(learn(rows.filter(row => row.start_ms < tailTo), tailTo).pending_sessions, 1);
  const complete = learn(rows, to);
  assertEquals(complete.pending_sessions, 0);
  assertEquals(complete.points[0].heat_sessions, 2);
  assertAlmostEquals(complete.points[0].cop!, 4.0, 1e-9);
});

Deno.test("a missing quarter inside a run is not idle and does not dilute the draw", () => {
  const { rows, to } = world([{ at: 10, quarters: 24, output: 12, capacity: 100 }, { at: 80, quarters: 24, output: 12, capacity: 100 }]);
  const holed = rows.filter((_, index) => index !== at(rows, 20, HEATER));
  const learned = learn(holed, to);
  assertEquals(learned.unbounded_sessions, 2); // the two halves either side of the hole
  assertEquals(learned.points[0].heat_sessions, 1);
  assertEquals(learned.points[0].electric_w[HEATER], 3000);
  assertEquals(learned.points[0].steady_hours, 22 * 0.25 - 0.75 + 22 * 0.25);
});

Deno.test("an unavailable heat meter keeps the draw and drops only that session's COP", () => {
  const { rows, to } = world([{ at: 10, quarters: 24, output: 12, capacity: 100 }, { at: 80, quarters: 24, output: 12, capacity: 100 }]);
  rows[at(rows, 90, HEATER)].heat_kwh = null;
  const learned = learn(rows, to);
  assertEquals(learned.points[0].heat_sessions, 1);
  assertAlmostEquals(learned.points[0].cop!, 4.0, 1e-9);
  assertEquals(learned.points[0].electric_w, { [HEATER]: 3000, [PUMP]: 760 });
});

Deno.test("an unavailable electricity counter in the heat tail is not idle time", () => {
  const { rows, to } = world([{ at: 10, quarters: 24, output: 12, capacity: 100 }, { at: 80, quarters: 24, output: 12, capacity: 100 }]);
  const learned = learn(rows.filter((_, index) => index !== at(rows, 36, HEATER)), to);
  assertEquals([learned.unbounded_sessions, learned.points[0].heat_sessions], [1, 1]);
});

Deno.test("runs closer together than the heat tail are one session", () => {
  const { rows, to } = world([{ at: 10, quarters: 12, output: 12, capacity: 100 }, { at: 25, quarters: 12, output: 12, capacity: 100 }], 120, { heatLag: 4 });
  const learned = learn(rows, to);
  assertEquals(learned.points[0].heat_sessions, 1);
  assertAlmostEquals(learned.points[0].cop!, 4.0, 1e-9);
});

Deno.test("without a heat meter the draw is still learned per setting", () => {
  const { rows, to } = world([{ at: 10, quarters: 24, output: 12, capacity: 100 }, { at: 80, quarters: 24, output: 12, capacity: 80 }], 200, { heatMeter: false });
  const byCapacity = Object.fromEntries(learn(rows, to).points.map(p => [p.settings[PUMP], [p.electric_w[PUMP], p.cop, p.heat_kwh]]));
  assertEquals(byCapacity, { 100: [760, null, null], 80: [410, null, null] });
});

Deno.test("a run cut by the start of the window gives draw but no session", () => {
  const { rows, to } = world([{ at: 10, quarters: 24, output: 12, capacity: 100 }, { at: 80, quarters: 24, output: 12, capacity: 100 }]);
  const learned = learn(rows, to, T0 + 20 * Q);
  assertEquals([learned.unbounded_sessions, learned.points[0].heat_sessions], [1, 1]);
});

Deno.test("a charger whose current changes during a session learns its draw at each current", () => {
  // 230 V x 3 phases; the current is moved every hour and part way through a quarter.
  const rows: DeviceQuarter[] = [];
  const amps = (i: number) => [6, 10, 16][Math.floor(i / 4) % 3];
  for (let i = 0; i < 64; i++) {
    const charging = i >= 4 && i < 52;
    rows.push({ start_ms: T0 + i * Q, device_key: CHARGER, energy_kwh: charging ? amps(i) * 690 / 4000 : 0,
      power_setting: i % 4 === 3 ? null : amps(i), heat_kwh: null });
  }
  const learned = learnOperatingPoints(rows, [CHARGER], [], T0, T0 + 64 * Q);
  assertEquals(Object.fromEntries(learned.points.map(p => [p.settings[CHARGER], p.electric_w[CHARGER]])),
    { 6: 4140, 10: 6900, 16: 11040 });
  assertEquals([learned.unattributed_sessions, learned.pending_sessions], [0, 0]); // no heat meter: no sessions
});

Deno.test("no primary keys or no quarters learn nothing and never throw", () => {
  assertEquals(learnOperatingPoints([], [HEATER], [PUMP], T0, T0 + Q).points, []);
  assertEquals(learnOperatingPoints(world([]).rows, [], [PUMP], T0, T0 + 400 * Q).points, []);
});
