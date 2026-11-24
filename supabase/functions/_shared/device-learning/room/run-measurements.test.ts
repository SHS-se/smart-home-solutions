import { assert, assertAlmostEquals, assertEquals } from "@std/assert";
import type { RoomMeanQuarter } from "./mean-observations.ts";
import { measureRoomRuns, roomHeatingRuns } from "./run-measurements.ts";
import { assessMeasuredRuns, fitMeasuredLine } from "./measured-lines.ts";
import type { MeasuredRoomRun } from "../../planner/models/room/measured-evidence.ts";

function hourlyRun(): RoomMeanQuarter[] {
  return [19, 20, 21, 22, 23, 22.8, 22.6, 22.4, 22.2, 22].map((room, i) => ({
    start_ms: i * 3_600_000, duration_s: 3600, room_c: room, outdoor_c: i * 10,
    house_c: 20, heat_w: i === 1 || i === 2 ? 1000 : 0, cooling: false, solar_w_per_m2: null,
  }));
}
Deno.test("native run onset and post-off peak share the identical energy/weather window", () => {
  const [run] = measureRoomRuns(hourlyRun()), point = run.heating!;
  assertEquals(point.on_ms, 3_600_000);
  assertEquals(point.peak_ms, 4.5 * 3_600_000);
  assertEquals(point.peak_end_ms, 5 * 3_600_000);
  assertEquals(point.energy_kwh, 2);
  assertEquals(point.hours, 3.5);
  assertEquals(point.room_start_c, 19.5);
  assertEquals(point.rise_c, 3.5);
  assertAlmostEquals(point.outdoor_c, 80 / 3.5);
  assertAlmostEquals(run.cooling!.c_per_h, .2);
  assertEquals(run.cooling!.energy_kwh, 0);
});
Deno.test("missing onset or middle weather keeps independent cooling; unknown power never becomes OFF", () => {
  const rows = hourlyRun(); rows[0].room_c = null;
  let run = measureRoomRuns(rows)[0]; assertEquals(run.heating, null); assert(run.cooling);
  rows[0].room_c = 19; rows[2].outdoor_c = null;
  run = measureRoomRuns(rows)[0]; assertEquals(run.heating, null); assert(run.cooling);
  rows[2].heat_w = null; assertEquals(roomHeatingRuns(rows), []);
});
Deno.test("partial peak intervals count their electricity and signed net rises survive", () => {
  const rows = hourlyRun(); rows.forEach((row, i) => { row.room_c = 21 - i; });
  const point = measureRoomRuns(rows)[0].heating!;
  assertEquals(point.energy_kwh, .5);
  assertEquals(point.hours, .5);
  assertEquals(point.c_per_kwh, -1);
  const corrected = hourlyRun(); corrected[4].room_c = null;
  assertEquals(measureRoomRuns(corrected)[0].heating, null);
  corrected[4].room_c = 23;
  assertEquals(measureRoomRuns(corrected)[0].heating!.peak_ms, 4.5 * 3_600_000);
});
Deno.test("cooling lines weight their own heater-off window, never the preceding heating energy", () => {
  const points: MeasuredRoomRun[] = [[9, 1], [1, 3]].map(([energy, hours], i) => ({
    id: String(i), from_ms: 0, on_ms: 1, off_ms: 2, to_ms: 3, energy_kwh: energy,
    heating: null, cooling: { from_ms: 0, to_ms: 1, hours,
      c_per_h: i ? 3 : 1, room_c: 20, outdoor_c: 0, house_c: 20, energy_kwh: 0 }, reasons: [],
  }));
  const result = assessMeasuredRuns(points, null);
  assertAlmostEquals(result.calibration.lines.cooling!.intercept, 2.5);
  assertEquals(result.calibration.lines.cooling!.points, 2);
});

Deno.test("a run's heating and cooling points are flagged independently against their own lines", () => {
  const runs: MeasuredRoomRun[] = Array.from({ length: 12 }, (_, i) => {
    const outdoor = i - 6, c_per_kwh = i === 3 ? -9 : 1.4, c_per_h = i === 7 ? 1.5 : .2 + (i % 3) * .01;
    return { id: String(i), from_ms: i, on_ms: i, off_ms: i + 1, to_ms: i + 2, energy_kwh: i === 3 ? .05 : .5,
      heating: { on_ms: i, peak_ms: i + 1, peak_end_ms: i + 2, energy_kwh: i === 3 ? .025 : .5, hours: .5,
        rise_c: c_per_kwh * .5, c_per_kwh: c_per_kwh + (i % 2) * .05, room_start_c: 20, room_peak_c: 20.5, room_mean_c: 20.2,
        outdoor_c: outdoor, house_c: 20, native_seconds: [900] },
      cooling: { from_ms: i + 1, to_ms: i + 2, hours: 2, c_per_h, room_c: 20, outdoor_c: outdoor, house_c: 20, energy_kwh: 0 },
      reasons: [] };
  });
  const { runs: assessed, calibration } = assessMeasuredRuns(runs, null);
  assertEquals(assessed[3].heating_status, "below_line");
  assertEquals(assessed[3].cooling_status, "consistent", "a bad heating point says nothing about the cooling point");
  assertEquals(assessed[7].heating_status, "consistent", "a bad cooling point says nothing about the heating point");
  assertEquals(assessed[7].cooling_status, "above_line");
  assertEquals([calibration.heating_flagged_runs, calibration.cooling_flagged_runs], [1, 1]);
  assert(assessed.every(run => !("disposition" in run)));
  // Residuals are distances from the drawn lines, not from loss-corrected references.
  assertAlmostEquals(assessed[3].heating_residual!, assessed[3].heating!.c_per_kwh - calibration.lines.heating!.intercept
    - calibration.lines.heating!.slope_per_c * (assessed[3].heating!.outdoor_c - calibration.lines.heating!.reference_outdoor_c));
});

Deno.test("descriptive monotonic lines retain all measured points after robust fitting", () => {
  const points = Array.from({ length: 10 }, (_, i) => ({ x: i, y: i === 5 ? 100 : 2 + i, weight: 1 }));
  const line = fitMeasuredLine(points, "rises", "c_per_kwh")!;
  assertEquals(line.points, 10); assert(line.slope_per_c >= 0); assertAlmostEquals(line.slope_per_c, 1, .01);
  const falling = fitMeasuredLine(points, "falls", "c_per_h")!;
  assertEquals(falling.slope_per_c, 0);
});

Deno.test("rising final means are censored peaks and off-phase warming stays signed", () => {
  const rising = hourlyRun(); rising.forEach((row, i) => { row.room_c = 19 + i; });
  assertEquals(measureRoomRuns(rising)[0].heating, null);
  const rows = hourlyRun();
  // A higher earlier peak remains known, followed by a lower warming tail.
  for (let i = 5; i < rows.length; i++) rows[i].room_c = 20 + i * .1;
  const measured = measureRoomRuns(rows)[0];
  assert(measured.heating); assertAlmostEquals(measured.cooling!.c_per_h, -.1);
});

Deno.test("a peak before switch-off cannot start the cooling window before the off-phase settling time", () => {
  const rows = hourlyRun();
  rows.forEach((row, i) => { row.room_c = i === 0 ? 20 : 24 - i * .2; });
  const point = measureRoomRuns(rows)[0].cooling!;
  assertEquals(point.from_ms, 4.5 * 3_600_000);
  assertEquals(point.to_ms, 6.5 * 3_600_000);
  assertAlmostEquals(point.c_per_h, .2);
});
