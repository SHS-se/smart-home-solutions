import { assertEquals } from "jsr:@std/assert@1";
import { heatPumpHours, learnHeatPumpStartup, type HeatPumpInterval } from "./heat-pump-startup.ts";

const HOUR = 3_600_000;
const T0 = Date.UTC(2026, 0, 1);
const hour = (i: number, watts: number, peak: number | null, outdoor: number | null = -8): HeatPumpInterval =>
  ({ start_ms: T0 + i * HOUR, duration_s: 3600, energy_kwh: watts / 1000, peak_w: peak, outdoor_c: outdoor });

/** Synthetic unit: 6 idle hours, a start, two recovery hours, then steady running. */
function day(d: number, outdoor = -8): HeatPumpInterval[] {
  const profile: [number, number][] = [
    ...Array.from({ length: 6 }, () => [40, 45] as [number, number]),
    [1500, 2900], [1400, 1900], [1300, 1800],
    ...Array.from({ length: 15 }, () => [1000, 1600] as [number, number]),
  ];
  return profile.map(([watts, peak], h) => hour(d * 24 + h, watts, peak, outdoor));
}

Deno.test("learns start peak, recovery and running draw per outdoor band", () => {
  const intervals = Array.from({ length: 30 }, (_, d) => day(d)).flat();
  const model = learnHeatPumpStartup(intervals, T0 + 30 * 24 * HOUR);
  assertEquals(model.bands.length, 1);
  const [band] = model.bands;
  assertEquals(band.band_c, -10);
  assertEquals(band.starts, 30);
  assertEquals([band.start_peak_w, band.start_peak_max_w, band.first_hour_w], [2900, 2900, 1500]);
  assertEquals(band.recovery_w, [1400, 1300]);
  assertEquals(band.recovery_peak_w, [1900, 1800]);
  assertEquals([band.running_w, band.running_peak_w], [1000, 1600]);
  // The first day's start has no observed hour before the history, so it is not a start.
  assertEquals(model.starts.length, 30);
});

Deno.test("checks the last 14 days against a fit of the days before them", () => {
  const intervals = Array.from({ length: 30 }, (_, d) => day(d)).flat();
  const model = learnHeatPumpStartup(intervals, T0 + 30 * 24 * HOUR);
  if (!model.check.available) throw new Error("check unavailable");
  assertEquals(model.check.starts, 14);
  assertEquals(model.check.starts_within_peak, 14);
  assertEquals(model.check.draw_error_w, 0);
  assertEquals(model.check.running_hours, 14 * 18);
  assertEquals(model.check.running_peaks_within, model.check.running_peak_hours);
});

Deno.test("a colder check period with higher peaks is reported, not hidden", () => {
  const intervals = [...Array.from({ length: 16 }, (_, d) => day(d)).flat(),
    ...Array.from({ length: 14 }, (_, d) => day(16 + d).map(row => row.peak_w === 2900
      ? { ...row, peak_w: 3200 } : row)).flat()];
  const model = learnHeatPumpStartup(intervals, T0 + 30 * 24 * HOUR);
  if (!model.check.available) throw new Error("check unavailable");
  assertEquals(model.check.starts, 14);
  assertEquals(model.check.starts_within_peak, 0);
  assertEquals(model.bands[0].start_peak_max_w, 3200);
});

Deno.test("a missing hour is unknown, never standby, and does not create a start", () => {
  // Idle, then a gap, then running: the running hour after the gap is not a start,
  // and only hours beyond any recovery a start in the gap could have had count as running.
  const intervals = [hour(0, 40, 45), hour(1, 40, 45), hour(3, 1500, 2900), hour(4, 1400, 1900),
    hour(5, 1300, 1800), hour(6, 1000, 1600)];
  const model = learnHeatPumpStartup(intervals, T0 + 10 * HOUR);
  assertEquals(model.starts, []);
  assertEquals(model.bands[0].starts, 0);
  assertEquals(model.bands[0].running_hours, 1);
  assertEquals(model.bands[0].running_w, 1000);
});

Deno.test("an hour needs four complete quarters or its native hour", () => {
  const quarter = (h: number, q: number, kwh: number, peak: number | null): HeatPumpInterval =>
    ({ start_ms: T0 + h * HOUR + q * 900_000, duration_s: 900, energy_kwh: kwh, peak_w: peak, outdoor_c: -3 });
  const hours = heatPumpHours([
    quarter(0, 0, 0.1, 500), quarter(0, 1, 0.2, 900), quarter(0, 2, 0.3, 2200), quarter(0, 3, 0.25, 1200),
    quarter(1, 0, 0.1, 500), quarter(1, 1, 0.2, null), quarter(1, 2, 0.3, 700), quarter(1, 3, 0.25, 800),
    quarter(2, 0, 0.1, 500), quarter(2, 1, 0.2, 600), quarter(2, 2, 0.3, 700),
  ]);
  assertEquals(hours.map(h => [h.start_ms, Math.round(h.mean_w), h.peak_w]), [
    [T0, 850, 2200],
    // A quarter without its peak keeps the hour's energy and leaves its peak unknown.
    [T0 + HOUR, 850, null],
  ]);
});

Deno.test("without a start before the check period the check is unavailable", () => {
  const intervals = Array.from({ length: 40 }, (_, i) => hour(i, 1000, 1600));
  const model = learnHeatPumpStartup(intervals, T0 + 40 * HOUR);
  assertEquals(model.check.available, false);
});

Deno.test("the hour still in progress is not evidence", () => {
  const intervals = [hour(0, 40, 45), hour(1, 1500, 2900)];
  assertEquals(learnHeatPumpStartup(intervals, T0 + 1.5 * HOUR).starts, []);
  assertEquals(learnHeatPumpStartup(intervals, T0 + 2 * HOUR).starts.length, 1);
});

Deno.test("a cooling hour is not heating evidence and ends a recovery like a gap", () => {
  const intervals = [hour(0, 40, 45, 25), { ...hour(1, 1500, 2900, 25), cooling: true }, hour(2, 1000, 1600, 25)];
  const model = learnHeatPumpStartup(intervals, T0 + 3 * HOUR);
  assertEquals(model.starts, []);
  // The running hour after the cooling hour could still be recovering from a start, so it is not running evidence.
  assertEquals(model.bands, []);
});

Deno.test("the draw is checked even before any peak has been observed", () => {
  const intervals = Array.from({ length: 30 }, (_, d) => day(d).map(row => ({ ...row, peak_w: null }))).flat();
  const model = learnHeatPumpStartup(intervals, T0 + 30 * 24 * HOUR);
  if (!model.check.available) throw new Error("check unavailable");
  assertEquals(model.check.draw_error_w, 0);
  assertEquals([model.check.starts, model.check.running_peak_hours], [0, 0]);
});
