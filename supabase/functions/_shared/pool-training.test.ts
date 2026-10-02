import { assert, assertEquals } from "jsr:@std/assert@1";
import {
  COP_REFERENCE_AIR_C,
  fitPoolLoss,
  fitPoolModel,
  fitPoolResponse,
  type PoolResponseSample,
  POOL_LOSS_SETTLE_QUARTERS,
  type PoolLossSample,
  type PoolTrainingSample,
  poolRefitIsDue,
  poolTrainingWindowStartMs,
  SLOT_HOURS,
} from "./pool-training.ts";
import { WATER_KWH_PER_M3_K } from "./planner/store-models.ts";
import { POOL_HISTORY_HEATER_KWH, POOL_HISTORY_START_MS, POOL_HISTORY_WATER_C } from "./pool-history.fixture.ts";

const VOLUME_M3 = 55;
const CAPACITY = VOLUME_M3 * WATER_KWH_PER_M3_K;

/**
 * Generate history from a known pool, so a fit can be checked against the
 * truth that produced it rather than against itself.
 */
function simulate({
  lossKwPerK = 0.35,
  ratedCop = 4.5,
  copPerAirC = 0.045,
  backgroundKw = 0,
  slots = 480,
  heatFraction = 0.35,
  airSwing = 8,
  noiseC = 0,
  heaterKw = 3.5,
}: Partial<{
  lossKwPerK: number;
  ratedCop: number;
  copPerAirC: number;
  backgroundKw: number;
  slots: number;
  heatFraction: number;
  airSwing: number;
  noiseC: number;
  heaterKw: number;
}> = {}): PoolTrainingSample[] {
  const samples: PoolTrainingSample[] = [];
  let water = 26;
  // Deterministic pseudo-noise, so a failure is reproducible.
  let seed = 42;
  const random = () => {
    seed = (seed * 1103515245 + 12345) % 2147483648;
    return seed / 2147483648;
  };
  for (let index = 0; index < slots; index += 1) {
    const air = 18 + airSwing * Math.sin((index / 96) * 2 * Math.PI);
    const heating = (index % 96) / 96 < heatFraction;
    const electricalKwh = heating ? heaterKw * SLOT_HOURS : 0;
    const cop = ratedCop * (1 + copPerAirC * (air - COP_REFERENCE_AIR_C));
    const heatKw = electricalKwh > 0 ? (electricalKwh / SLOT_HOURS) * cop : 0;
    const netKw = heatKw - lossKwPerK * (water - air) + backgroundKw;
    const next = water + (netKw * SLOT_HOURS) / CAPACITY +
      (noiseC > 0 ? (random() - 0.5) * noiseC : 0);
    samples.push({
      water_temperature_c: water,
      next_water_temperature_c: next,
      outdoor_temperature_c: air,
      electrical_kwh: electricalKwh,
    });
    water = next;
  }
  return samples;
}

Deno.test("recovers the loss and COP that generated the history", () => {
  const result = fitPoolModel(simulate(), VOLUME_M3);
  assert("fitted" in result, `expected a fit, got ${JSON.stringify(result)}`);

  const fit = result.fitted;
  assert(
    Math.abs(fit.loss_kw_per_k - 0.35) < 0.02,
    `loss ${fit.loss_kw_per_k} should recover 0.35`,
  );
  assert(
    Math.abs(fit.rated_cop - 4.5) < 0.2,
    `COP ${fit.rated_cop} should recover 4.5`,
  );
  assert(
    Math.abs(fit.cop_per_air_c - 0.045) < 0.01,
    `COP slope ${fit.cop_per_air_c} should recover 0.045`,
  );
  assert(fit.r2 > 0.9);
});

Deno.test("a different pool gives different numbers, not the seeded ones", () => {
  const leaky = fitPoolModel(
    simulate({ lossKwPerK: 0.9, ratedCop: 3.2 }),
    VOLUME_M3,
  );
  assert("fitted" in leaky);
  assert(leaky.fitted.loss_kw_per_k > 0.7, "a covered pool is not an open one");
  assert(leaky.fitted.rated_cop < 4, "and a poor pump is not a good one");
});

Deno.test("noise widens the estimate without breaking it", () => {
  const result = fitPoolModel(simulate({ noiseC: 0.02 }), VOLUME_M3);
  assert("fitted" in result);
  assert(Math.abs(result.fitted.loss_kw_per_k - 0.35) < 0.1);
});

Deno.test("too little history is refused rather than guessed", () => {
  const result = fitPoolModel(simulate({ slots: 100 }), VOLUME_M3);
  assertEquals("rejected" in result && result.rejected, "insufficient_samples");
});

Deno.test("an unheated window cannot identify a COP", () => {
  // The August case exactly: the pool sits at temperature and the heater never
  // runs, so the cooling term explains everything and the COP is invented.
  const result = fitPoolModel(simulate({ heatFraction: 0 }), VOLUME_M3);
  assertEquals("rejected" in result && result.rejected, "insufficient_heating");
});

Deno.test("heating at one air temperature cannot identify the COP slope", () => {
  const result = fitPoolModel(simulate({ airSwing: 0.5 }), VOLUME_M3);
  assertEquals(
    "rejected" in result && result.rejected,
    "insufficient_air_spread",
  );
});

Deno.test("a physically impossible result is refused however well it fits", () => {
  // A pump returning less heat than the electricity it drew.
  const result = fitPoolModel(
    simulate({ ratedCop: 0.4, copPerAirC: 0 }),
    VOLUME_M3,
  );
  assert("rejected" in result);
  assertEquals(result.rejected, "unphysical");
});

Deno.test("a rejection still reports how much evidence there was", () => {
  const result = fitPoolModel(simulate({ heatFraction: 0 }), VOLUME_M3);
  assert("rejected" in result);
  assertEquals(result.heated_sample_count, 0);
  assert(result.sample_count > 400, "the refusal is about heating, not history");
});

const HOUR = 3_600_000;
const DAY = 86_400_000;
const NOW = Date.parse("2026-09-10T12:00:00Z");

Deno.test("without an epoch the window is the rolling one", () => {
  assertEquals(
    poolTrainingWindowStartMs(NOW, null, 21),
    NOW - 21 * DAY,
  );
});

Deno.test("an epoch inside the rolling window truncates it", () => {
  const epoch = Date.parse("2026-09-01T00:00:00Z");
  assertEquals(poolTrainingWindowStartMs(NOW, epoch, 21), epoch);
});

Deno.test("an epoch older than the rolling window does not extend it", () => {
  // A machine commissioned last year must not drag a year of samples in.
  const epoch = Date.parse("2025-09-01T00:00:00Z");
  assertEquals(poolTrainingWindowStartMs(NOW, epoch, 21), NOW - 21 * DAY);
});

Deno.test("no samples survive an epoch set in the present", () => {
  // The window collapses to nothing, so `fitPoolModel` refuses for want of
  // evidence rather than blending two machines into a confident answer.
  assertEquals(poolTrainingWindowStartMs(NOW, NOW, 21), NOW);
});

Deno.test("a refit waits out the interval when nothing has changed", () => {
  assertEquals(poolRefitIsDue(NOW, NOW - 3 * HOUR, null, 24), false);
  assertEquals(poolRefitIsDue(NOW, NOW - 25 * HOUR, null, 24), true);
});

Deno.test("an epoch recorded after the standing fit forces one immediately", () => {
  const fittedAt = NOW - 3 * HOUR;
  assertEquals(poolRefitIsDue(NOW, fittedAt, NOW - HOUR, 24), true);
});

Deno.test("an epoch older than the standing fit does not force one", () => {
  // The fit already saw only post-epoch samples; nothing has been restated.
  const fittedAt = NOW - 3 * HOUR;
  assertEquals(poolRefitIsDue(NOW, fittedAt, NOW - 10 * DAY, 24), false);
});

const timed = (samples: PoolTrainingSample[]): PoolLossSample[] =>
  samples.map((sample, index) => ({ ...sample, start_ms: index * SLOT_HOURS * 3_600_000 }));

Deno.test("the idle loss recovers the pool's own loss, not the seeded one", () => {
  for (const lossKwPerK of [0.075, 0.35]) {
    const result = fitPoolLoss(timed(simulate({ lossKwPerK, slots: 96 * 7 })), VOLUME_M3);
    assert("fitted" in result, JSON.stringify(result));
    assert(
      Math.abs(result.fitted.loss_kw_per_k - lossKwPerK) < lossKwPerK * 0.02,
      `loss ${result.fitted.loss_kw_per_k} should recover ${lossKwPerK}`,
    );
    assertEquals(result.fitted.run_count, 7);
  }
});

Deno.test("the idle loss needs no air spread and no heating to be identified", () => {
  // The seasons that refuse a COP fit are exactly the ones with most idle nights.
  const flat = fitPoolLoss(timed(simulate({ lossKwPerK: 0.1, airSwing: 0.5, heatFraction: 0.1 })), VOLUME_M3);
  assert("fitted" in flat);
  assert(Math.abs(flat.fitted.loss_kw_per_k - 0.1) < 0.005);
  const unheated = fitPoolLoss(timed(simulate({ lossKwPerK: 0.1, heatFraction: 0 })), VOLUME_M3);
  assert("fitted" in unheated);
  assert(Math.abs(unheated.fitted.loss_kw_per_k - 0.1) < 0.005);
});

Deno.test("readings settling after the heater stops do not count as cooling", () => {
  const samples = timed(simulate({ lossKwPerK: 0.1 }));
  const clean = fitPoolLoss(samples, VOLUME_M3);
  // The sensor reads the stagnant pipe a few tenths low once the pump stops.
  for (let index = 1; index < samples.length; index += 1) {
    if (samples[index - 1].electrical_kwh > 0 && samples[index].electrical_kwh === 0) {
      for (let k = 0; k < POOL_LOSS_SETTLE_QUARTERS; k += 1) {
        const settling = samples[index + k];
        if (settling) settling.next_water_temperature_c -= 0.3 * (1 - k / POOL_LOSS_SETTLE_QUARTERS);
      }
    }
  }
  const settled = fitPoolLoss(samples, VOLUME_M3);
  assert("fitted" in clean && "fitted" in settled);
  assertEquals(settled.fitted.loss_kw_per_k, clean.fitted.loss_kw_per_k);
});

Deno.test("gaps split stretches and short stretches are not counted", () => {
  const samples = timed(simulate({ lossKwPerK: 0.1, heatFraction: 0, slots: 96 * 2 }));
  const whole = fitPoolLoss(samples, VOLUME_M3);
  assert("fitted" in whole);
  assertEquals(whole.fitted.run_count, 1);
  // Every tenth quarter missing leaves stretches too short to judge.
  const holed = fitPoolLoss(samples.filter((_, index) => index % 10 !== 0), VOLUME_M3);
  assertEquals("rejected" in holed && holed.rejected, "insufficient_idle");
});

Deno.test("a pool that is always heating offers no idle loss", () => {
  const result = fitPoolLoss(timed(simulate({ heatFraction: 0.95 })), VOLUME_M3);
  assertEquals("rejected" in result && result.rejected, "insufficient_idle");
});

Deno.test("a pool that warms with nothing heating it is refused", () => {
  const result = fitPoolLoss(timed(simulate({ lossKwPerK: 0.1, backgroundKw: 5, heatFraction: 0 })), VOLUME_M3);
  assertEquals("rejected" in result && result.rejected, "unphysical");
});

/** The measured week as quarters: the hourly means joined by straight lines, each hour's energy spread over it. */
function measuredQuarters(): PoolResponseSample[] {
  const at = (quarter: number) => {
    const hour = (quarter - 2) / 4;
    const index = Math.min(POOL_HISTORY_WATER_C.length - 2, Math.max(0, Math.floor(hour)));
    return POOL_HISTORY_WATER_C[index] + (POOL_HISTORY_WATER_C[index + 1] - POOL_HISTORY_WATER_C[index]) * (hour - index);
  };
  const samples: PoolResponseSample[] = [];
  for (let quarter = 2; quarter < (POOL_HISTORY_WATER_C.length - 1) * 4 + 2; quarter += 1) {
    samples.push({
      start_ms: POOL_HISTORY_START_MS + quarter * 900_000,
      water_temperature_c: at(quarter),
      next_water_temperature_c: at(quarter + 1),
      electrical_kwh: POOL_HISTORY_HEATER_KWH[Math.floor(quarter / 4)] / 4,
    });
  }
  return samples;
}

Deno.test("the measured response finds the pool's stall below 29 °C, cooling and heating alike", () => {
  const bins = fitPoolResponse(measuredQuarters());
  const bin = (atC: number) => bins.find((entry) => entry.at_c === atC)!;
  // Above 29 °C the unheated pool falls about 0.04 °C an hour, and a heater kWh adds 0.07 °C or more.
  for (const atC of [29.125, 29.375, 29.625]) {
    assert(bin(atC).idle_c_per_h! < -0.035 && bin(atC).idle_c_per_h! > -0.05, `${atC}: ${bin(atC).idle_c_per_h}`);
    assert(bin(atC).heat_c_per_kwh! > 0.07, `${atC}: ${bin(atC).heat_c_per_kwh}`);
  }
  // Just below it the same pool falls a third as fast and a kWh adds half as much.
  const stall = bin(28.875);
  assert(stall.idle_hours > 24, "most of the idle time was spent here");
  assert(stall.idle_c_per_h! > -0.02 && stall.idle_c_per_h! < 0, `stall cooling: ${stall.idle_c_per_h}`);
  assert(stall.heat_c_per_kwh! > 0.02 && stall.heat_c_per_kwh! < 0.045, `stall heating: ${stall.heat_c_per_kwh}`);
});

Deno.test("a bin is offered only what it measured, and a gap in the record is not a stretch of cooling", () => {
  const quarter = (index: number, waterC: number, nextC: number, kwh = 0): PoolResponseSample =>
    ({ start_ms: index * 900_000, water_temperature_c: waterC, next_water_temperature_c: nextC, electrical_kwh: kwh });
  // Four hours idle at 30 °C falling 0.01 °C a quarter, never heated.
  const idle = Array.from({ length: 16 }, (_, index) => quarter(index, 30.2 - index * 0.01, 30.2 - (index + 1) * 0.01));
  const [only] = fitPoolResponse(idle);
  assertEquals(only.at_c, 30.125);
  assert(Math.abs(only.idle_c_per_h! + 0.04) < 1e-6, `${only.idle_c_per_h}`);
  assertEquals(only.heat_c_per_kwh, null);
  // Two hours is too little to offer a rate.
  assertEquals(fitPoolResponse(idle.slice(0, 8)), []);
  // Heating: 1 kWh a quarter for four quarters raising 0.05 °C each, then settling, set against the usual cooling.
  const heated = [
    ...idle,
    ...Array.from({ length: 4 }, (_, index) => quarter(16 + index, 30.04 + index * 0.05, 30.04 + (index + 1) * 0.05, 1)),
  ];
  const warm = fitPoolResponse(heated).find((entry) => entry.heat_c_per_kwh !== null)!;
  assert(Math.abs(warm.heat_c_per_kwh! - (0.2 + 0.04) / 4) < 1e-3, `${warm.heat_c_per_kwh}`);
});
