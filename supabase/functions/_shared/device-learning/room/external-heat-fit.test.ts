import { assert, assertAlmostEquals, assertEquals } from "@std/assert";
import { finalizeIndependentRoomBand, fitIndependentRoomBand, fitIndependentRoomBandCell, prepareIndependentRoomBand, ROOM_BAND_FIT_CELL_COUNT } from "./mean-observations.ts";
import { syntheticRoomPlant } from "./native-mean.fixture.ts";

/** Independently generated synthetic plant. The room/heater state is RK4
 * integrated by the fixture; an independent analytic linear plant supplies
 * extra heat, including continued warmth after its input has stopped. No
 * production transition operator is used to generate the measurements. */
function plant(additionalHeat: boolean, durations: (900 | 3600)[] = [900]) {
  const gain = .002, house = .04, outdoor = .035, exchange = house + outdoor;
  const result = syntheticRoomPlant(durations, 600, .5, .0001, {
    gain, houseGain: house, outdoorGain: outdoor, background: .02, roomStart: 19,
    // The fixture integrates the observation mean by quadrature. Resolve it
    // below floating-point fit precision so its heater-switch integration
    // error cannot masquerade as a small, deterministic heat contribution.
    startMs: Date.UTC(2025, 0, 1), steps: 600,
    forcing: i => ({ outdoor: -2.5 + Math.sin(i / 17), house: 20 + .4 * Math.cos(i / 30),
      watts: i % 21 < 10 ? 500 : 0, solar: Math.max(0, 200 * Math.sin(i / 96 * Math.PI * 2)) }),
  });
  let warmth = 0;
  const forcing: number[] = [];
  result.rows.forEach((row, i) => {
    const extra = additionalHeat && i % 140 >= 30 && i % 140 < 56 ? 1.4 : 0;
    forcing.push(extra);
    const hours = row.duration_s! / 3600;
    const decay = Math.exp(-exchange * hours), meanFraction = (1 - decay) / (exchange * hours);
    const meanWarmth = warmth * meanFraction + extra / exchange * (1 - meanFraction);
    warmth = warmth * decay + extra / exchange * (1 - decay);
    row.room_c! += meanWarmth;
    // Simulate expired categorical history, except for retained fan labels.
    // This fact admits heating/off/fan, not an assertion of active heating.
    row.operation_fact = "00000000-0000-4000-8000-000000000001";
    row.cooling = row.heat_w === 0 ? true : null;
    if (row.heat_w === 0) row.heat_w = 12;
  });
  return { ...result, forcing };
}

Deno.test("joint band fit separates extra heat from heater gain with fan, heater overlap and thermal tails", () => {
  const { rows, forcing } = plant(true), original = structuredClone(rows);
  const fitted = fitIndependentRoomBand(rows, () => true, 500).result;
  assert(fitted.ok);
  assert(fitted.model.response_family === "finite");
  assertAlmostEquals(fitted.model.gain_c_per_wh, .002, .0001);
  assertAlmostEquals(fitted.model.cooling_constant_per_h, .035, .001);
  assertAlmostEquals(fitted.model.house_coupling_per_h!, .04, .001);
  assertAlmostEquals(fitted.model.heat_lag_h!, .5, 1e-12);
  assertAlmostEquals(fitted.model.solar_gain_c_per_h_per_wm2!, .0001, .00001);
  // The tiny fan draw belongs to the electrical observation. Its affine
  // offset must not become an invented positive fireplace forecast.
  assertAlmostEquals(fitted.model.background_gain_c_per_h! + fitted.model.gain_c_per_wh * 12, .02, .003);
  const evidence = fitted.learning_evidence?.additional_heat;
  assert(evidence?.selected && evidence.converged);
  assert(evidence.validation_nll! < evidence.plain_validation_nll!);
  const inside = rows.map(row => fitted.additional_heat_intervals!.some(interval =>
    interval.probability > .5 && row.start_ms >= interval.from_ms && row.start_ms < interval.to_ms));
  const fire = forcing.filter(value => value > 0).length;
  assert(inside.filter((included, i) => included && forcing[i] > 0).length / fire > .9);
  assert(inside.filter((included, i) => included && forcing[i] === 0).length < fire * .2);
  assert(rows.some((row, i) => forcing[i] > 0 && row.heat_w! > 100));
  assert(rows.some((row, i) => forcing[i] > 0 && row.heat_w === 12));
  assertEquals(rows, original);
});

Deno.test("band thermal and external training fits do not see future held-out room temperatures", () => {
  const { rows } = plant(true), changed = structuredClone(rows);
  // The final third is the common chronological holdout. Keep its support
  // and driver observations intact while replacing its temperature outcomes.
  changed.slice(400).forEach((row, i) => { row.room_c! += 2 * Math.sin(i / 9) + .01 * i; });
  const first = prepareIndependentRoomBand(rows, () => true, 500);
  const second = prepareIndependentRoomBand(changed, () => true, 500);
  assertEquals(first.noiseReference.training, second.noiseReference.training);
  assert(first.noiseReference.full !== second.noiseReference.full);
  // Grid index 2 is the training half of the independently integrated .5h lag.
  const actual = fitIndependentRoomBandCell(first, 2), futureChanged = fitIndependentRoomBandCell(second, 2);
  assert(actual.additional_heat.finite?.observation_fit?.converged);
  assertEquals(actual, futureChanged);
});

Deno.test("measured solar and neighboring warmth fit without an invented external-heat episode", () => {
  const { rows } = plant(false);
  const fitted = fitIndependentRoomBand(rows, () => true, 500).result;
  assert(fitted.ok);
  assert(fitted.model.response_family === "finite");
  assertAlmostEquals(fitted.model.gain_c_per_wh, .002, .0001);
  assertAlmostEquals(fitted.model.cooling_constant_per_h, .035, .001);
  assertAlmostEquals(fitted.model.house_coupling_per_h!, .04, .001);
  assertAlmostEquals(fitted.model.solar_gain_c_per_h_per_wm2!, .0001, .00001);
  assert(!fitted.learning_evidence?.additional_heat?.selected);
});

Deno.test("small independent Gaussian thermometer noise does not invent additional heating", () => {
  const { rows } = plant(false);
  let seed = 827;
  const random = () => ((seed = (1664525 * seed + 1013904223) >>> 0) + .5) / 4294967296;
  rows.forEach(row => { row.room_c! += .002 * Math.sqrt(-2 * Math.log(random())) * Math.cos(2 * Math.PI * random()); });
  const fitted = fitIndependentRoomBand(rows, () => true, 500).result;
  assert(fitted.ok);
  assert(fitted.model.response_family === "finite");
  assertAlmostEquals(fitted.model.gain_c_per_wh, .002, .0001);
  assertAlmostEquals(fitted.model.cooling_constant_per_h, .035, .002);
  assertAlmostEquals(fitted.model.house_coupling_per_h!, .04, .002);
  assert(!fitted.learning_evidence?.additional_heat?.selected);
});

Deno.test("mixed hourly and quarterly physical observations preserve one identifiable heater and additional forcing", () => {
  const { rows } = plant(true, [900, 3600, 3600, 900]), original = structuredClone(rows);
  const fitted = fitIndependentRoomBand(rows, () => true, 500).result;
  assert(fitted.ok);
  assert(fitted.model.response_family === "finite");
  assertAlmostEquals(fitted.model.gain_c_per_wh, .002, .0001);
  assertAlmostEquals(fitted.model.cooling_constant_per_h, .035, .002);
  assertAlmostEquals(fitted.model.house_coupling_per_h!, .04, .002);
  assertAlmostEquals(fitted.model.heat_lag_h!, .5, 1e-12);
  assertAlmostEquals(fitted.model.solar_gain_c_per_h_per_wm2!, .0001, .00002);
  const evidence = fitted.learning_evidence?.additional_heat;
  assert(evidence?.selected);
  assert(evidence.parameters.sigma_by_class?.["900/900"] !== undefined);
  assert(evidence.parameters.sigma_by_class?.["3600/3600"] !== undefined);
  assertEquals(rows, original);
});

Deno.test("mixed duration-dependent thermometer noise is not mistaken for an additional heating source", () => {
  const { rows } = plant(false, [900, 3600, 3600, 900]), original = structuredClone(rows);
  let seed = 827;
  const random = () => ((seed = (1664525 * seed + 1013904223) >>> 0) + .5) / 4294967296;
  rows.forEach(row => {
    const sigma = row.duration_s === 900 ? .002 : .02;
    row.room_c! += sigma * Math.sqrt(-2 * Math.log(random())) * Math.cos(2 * Math.PI * random());
  });
  const noisy = structuredClone(rows);
  const fitted = fitIndependentRoomBand(rows, () => true, 500).result;
  assert(fitted.ok);
  assert(fitted.model.response_family === "finite");
  assertAlmostEquals(fitted.model.gain_c_per_wh, .002, .00015);
  assertAlmostEquals(fitted.model.cooling_constant_per_h, .035, .003);
  assertAlmostEquals(fitted.model.house_coupling_per_h!, .04, .003);
  assert(!fitted.learning_evidence?.additional_heat?.selected);
  assertEquals(rows, noisy);
  assert(rows.some((row, i) => row.room_c !== original[i].room_c));
});

Deno.test("all lag and response candidates share a partition-local empirical noise reference", () => {
  const { rows } = plant(true);
  const prepared = prepareIndependentRoomBand(rows.slice(20, 50), () => true, 500);
  const meanSquareChange = (observations: typeof rows) => observations.slice(1).reduce((sum, row, i) =>
    sum + (row.room_c! - observations[i].room_c!) ** 2, 0) / (observations.length - 1);
  assertAlmostEquals(prepared.noiseReference.full, meanSquareChange(prepared.rows), 1e-12);
  assertAlmostEquals(prepared.noiseReference.training, meanSquareChange(prepared.trainingRows), 1e-12);
  let compared = 0;
  const cells: ReturnType<typeof fitIndependentRoomBandCell>[] = [];
  for (let i = 0; i < ROOM_BAND_FIT_CELL_COUNT; i++) {
    const cell = fitIndependentRoomBandCell(prepared, i);
    cells.push(cell);
    for (const candidate of [...Object.values(cell.fits), ...Object.values(cell.additional_heat)]) {
      if (!candidate?.observation_fit) continue;
      compared++;
      assertEquals(candidate.observation_fit.parameters.noise_reference_c2, prepared.noiseReference[cell.partition]);
      for (const sigma of Object.values(candidate.observation_fit.parameters.sigma_by_class ?? {})) {
        assert(sigma ** 2 >= prepared.noiseReference[cell.partition] / (candidate.n + 3) * (1 - 1e-10));
      }
    }
  }
  assert(compared > 10);
  // Only 29 measured transitions cannot identify all physical coordinates of
  // this short, confounded burst. It must retain that limited-data evidence,
  // while the proper prior prevents a spurious zero-noise publication.
  const fitted = finalizeIndependentRoomBand(prepared, cells).result;
  assert(fitted.ok);
  assertEquals(fitted.model.sample_count, 29);
  assert(fitted.warnings?.includes("insufficient_samples"));
});
