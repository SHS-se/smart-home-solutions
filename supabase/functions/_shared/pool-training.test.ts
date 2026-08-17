import { assert, assertEquals } from "jsr:@std/assert@1";
import {
  COP_REFERENCE_AIR_C,
  fitPoolModel,
  type PoolTrainingSample,
  SLOT_HOURS,
} from "./pool-training.ts";
import { WATER_KWH_PER_M3_K } from "./store-models.ts";

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
