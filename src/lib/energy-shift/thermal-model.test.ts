import {
  fitThermalZone,
  projectZoneTemperature,
  quarterEnergyToWatts,
  SLOT_HOURS,
  solveLinearSystem,
  type ThermalTrainingSample,
  type ThermalZoneModel,
} from '../../../supabase/functions/_shared/planner/thermal-model.ts';

const assert = (condition: unknown, message: string) => {
  if (!condition) throw new Error(message);
};

const assertEquals = (actual: unknown, expected: unknown, message: string) => {
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    throw new Error(`${message}: ${JSON.stringify(actual)} !== ${JSON.stringify(expected)}`);
  }
};

const assertClose = (
  actual: number,
  expected: number,
  tolerance: number,
  message: string,
) => {
  if (!(Math.abs(actual - expected) <= tolerance)) {
    throw new Error(`${message}: ${actual} is not within ${tolerance} of ${expected}`);
  }
};

// A plausible bedroom: ~1.2 kWh/°C of structure, and a 1 kW panel heater.
const TRUE_GAIN = 1 / 1200; // °C per Wh
const TRUE_COOLING = 0.06; // per hour
const TRUE_BACKGROUND = 0.05; // °C per hour

function syntheticSamples(
  count: number,
  dutyPattern: (index: number) => number,
  ratedPowerW = 1000,
): ThermalTrainingSample[] {
  const samples: ThermalTrainingSample[] = [];
  let indoor = 20;
  for (let index = 0; index < count; index += 1) {
    // Outdoor swings daily so the loss term is identifiable.
    const outdoor = 4 + 6 * Math.sin((2 * Math.PI * index) / 96);
    const power = dutyPattern(index) * ratedPowerW;
    const next = indoor + SLOT_HOURS * (
      TRUE_GAIN * power + TRUE_COOLING * (outdoor - indoor) + TRUE_BACKGROUND
    );
    samples.push({
      room_temperature_c: indoor,
      next_room_temperature_c: next,
      outdoor_temperature_c: outdoor,
      heat_input_w: power,
    });
    indoor = next;
  }
  return samples;
}

// Scheduled heating bands: hard on morning and evening, off in between.
const bandedDuty = (index: number) => {
  const quarterOfDay = index % 96;
  if (quarterOfDay >= 22 && quarterOfDay < 30) return 1;
  if (quarterOfDay >= 60 && quarterOfDay < 76) return 1;
  return 0;
};

Deno.test('solveLinearSystem recovers a known solution', () => {
  const solution = solveLinearSystem(
    [[2, 1, -1], [-3, -1, 2], [-2, 1, 2]],
    [8, -11, -3],
  );
  assert(solution !== null, 'expected a solution');
  assertClose(solution![0], 2, 1e-9, 'x');
  assertClose(solution![1], 3, 1e-9, 'y');
  assertClose(solution![2], -1, 1e-9, 'z');
});

Deno.test('solveLinearSystem rejects a singular design', () => {
  assertEquals(
    solveLinearSystem([[1, 2, 3], [2, 4, 6], [1, 1, 1]], [1, 2, 1]),
    null,
    'a rank-deficient system has no unique solution',
  );
});

Deno.test('fitThermalZone recovers the generating parameters', () => {
  const result = fitThermalZone(syntheticSamples(1500, bandedDuty), 1000);
  assert(result.ok, `expected a fit, got ${JSON.stringify(result)}`);
  if (!result.ok) return;
  const model = result.model;
  assertClose(model.gain_c_per_wh, TRUE_GAIN, 1e-6, 'gain');
  assertClose(model.cooling_constant_per_h, TRUE_COOLING, 1e-4, 'cooling');
  assertClose(model.background_gain_c_per_h, TRUE_BACKGROUND, 1e-4, 'background');
  assertClose(model.thermal_capacity_wh_per_c, 1200, 1, 'capacity');
  assertClose(model.heat_loss_w_per_c, 1200 * TRUE_COOLING, 0.5, 'UA');
  assertClose(model.heating_rate_c_per_h!, TRUE_GAIN * 1000, 1e-4, 'heating rate');
  assert(model.r2 > 0.99, `expected a tight fit, got r2 ${model.r2}`);
});

Deno.test('fitThermalZone separates background gains from envelope loss', () => {
  // The classic hand-rolled error attributes every degree of indoor-outdoor
  // difference to the heaters, which inflates the loss coefficient. A zone
  // with real background gains must still report the true UA.
  const result = fitThermalZone(syntheticSamples(1500, bandedDuty), 1000);
  assert(result.ok, 'expected a fit');
  if (!result.ok) return;
  assertClose(
    result.model.background_gain_c_per_h,
    TRUE_BACKGROUND,
    1e-3,
    'background gain must not be absorbed into heat loss',
  );
});

Deno.test('fitThermalZone refuses a zone whose sensor tracks outdoor air', () => {
  const samples: ThermalTrainingSample[] = [];
  for (let index = 0; index < 1000; index += 1) {
    const outdoor = 4 + 6 * Math.sin((2 * Math.PI * index) / 96);
    samples.push({
      room_temperature_c: outdoor + 0.4,
      next_room_temperature_c: outdoor + 0.4,
      outdoor_temperature_c: outdoor,
      heat_input_w: 0,
    });
  }
  const result = fitThermalZone(samples, 1000);
  assert(!result.ok, 'an outdoor sensor must not fit as a room');
  if (result.ok) return;
  assertEquals(result.reason, 'sensor_tracks_outdoor', 'rejection reason');
});

Deno.test('fitThermalZone refuses a zone with too little history', () => {
  const result = fitThermalZone(syntheticSamples(96, bandedDuty), 1000);
  assert(!result.ok, 'one day is not enough to fit a zone');
  if (result.ok) return;
  assertEquals(result.reason, 'insufficient_samples', 'rejection reason');
});

Deno.test('fitThermalZone refuses a barely-heated autumn window', () => {
  // Three weeks of history with a single heated day. Not rank-deficient, so
  // it solves - but the heating gain rests on almost nothing. This is the
  // shape every autumn takes as the window drains of summer quarters.
  const samples = syntheticSamples(
    2016,
    index => (index < 40 ? 1 : 0),
  );
  const result = fitThermalZone(samples, 1000);
  assert(!result.ok, 'a barely-heated window must not produce a model');
  if (result.ok) return;
  assertEquals(result.reason, 'insufficient_heating', 'rejection reason');
});

Deno.test('fitThermalZone accepts a window once the season is under way', () => {
  // The same window with heating on most days clears the threshold.
  const result = fitThermalZone(syntheticSamples(2016, bandedDuty), 1000);
  assert(result.ok, 'a properly heated window must fit');
});

Deno.test('fitThermalZone refuses a zone whose heater never ran', () => {
  // A summer window: the gain column is all zeros, so the parameter is
  // unidentifiable rather than merely uncertain. Reported as insufficient
  // heating rather than as a bare singularity, because that names the cause.
  const result = fitThermalZone(syntheticSamples(1000, () => 0), 1000);
  assert(!result.ok, 'an unheated zone cannot identify a heating gain');
  if (result.ok) return;
  assertEquals(result.reason, 'insufficient_heating', 'rejection reason');
});

Deno.test('projectZoneTemperature cools a zone with no heat input', () => {
  const model: ThermalZoneModel = {
    gain_c_per_wh: TRUE_GAIN,
    cooling_constant_per_h: TRUE_COOLING,
    background_gain_c_per_h: 0,
    thermal_capacity_wh_per_c: 1200,
    heat_loss_w_per_c: 72,
    time_constant_h: 1 / TRUE_COOLING,
    heating_rate_c_per_h: TRUE_GAIN * 1000,
    r2: 1,
    sample_count: 1000,
    residual_std_c: 0,
  };
  const projection = projectZoneTemperature(
    model,
    20,
    new Array(8).fill(0),
    new Array(8).fill(0),
  );
  assertEquals(projection.length, 8, 'one value per slot');
  for (let index = 1; index < projection.length; index += 1) {
    assert(
      projection[index] < projection[index - 1],
      'an unheated zone must cool toward outdoor air',
    );
  }
});

Deno.test('quarterEnergyToWatts converts a quarter of energy to mean power', () => {
  assertEquals(quarterEnergyToWatts(0.25), 1000, '0.25 kWh over 15 minutes is 1 kW');
});

// --- Solar gain ----------------------------------------------------------
//
// The zone's fourth regressor. These tests generate a room whose temperature
// is driven by a known solar coefficient and check both that the fit recovers
// it and that the old three-regressor fit does the specific wrong thing the
// fourth column was added to stop.

const TRUE_SOLAR = 0.0015; // °C per hour per W/m²

/** A day of sun, dimmed by that day's cloud so bright and dull days differ. */
const irradianceAt = (index: number): number => {
  const quarterOfDay = index % 96;
  const day = Math.floor(index / 96);
  if (quarterOfDay < 24 || quarterOfDay >= 72) return 0;
  const cloud = [1, 0.25, 0.7, 0.1, 0.9, 0.45][day % 6];
  return 600 * cloud * Math.sin((Math.PI * (quarterOfDay - 24)) / 48);
};

function sunlitSamples(
  count: number,
  dutyPattern: (index: number) => number,
  ratedPowerW = 1000,
  withIrradiance = true,
): ThermalTrainingSample[] {
  const samples: ThermalTrainingSample[] = [];
  let indoor = 20;
  for (let index = 0; index < count; index += 1) {
    const outdoor = 4 + 6 * Math.sin((2 * Math.PI * index) / 96);
    const irradiance = irradianceAt(index);
    const power = dutyPattern(index) * ratedPowerW;
    const next = indoor + SLOT_HOURS * (
      TRUE_GAIN * power + TRUE_COOLING * (outdoor - indoor) +
      TRUE_BACKGROUND + TRUE_SOLAR * irradiance
    );
    samples.push({
      room_temperature_c: indoor,
      next_room_temperature_c: next,
      outdoor_temperature_c: outdoor,
      heat_input_w: power,
      ...(withIrradiance ? { solar_w_per_m2: irradiance } : {}),
    });
    indoor = next;
  }
  return samples;
}

Deno.test('fitThermalZone recovers a known solar coefficient', () => {
  const result = fitThermalZone(sunlitSamples(1500, bandedDuty), 1000);
  assert(result.ok, `expected a fit, got ${JSON.stringify(result)}`);
  if (!result.ok) return;
  assertClose(result.model.gain_c_per_wh, TRUE_GAIN, 1e-6, 'gain');
  assertClose(result.model.cooling_constant_per_h, TRUE_COOLING, 1e-4, 'cooling');
  assertClose(
    result.model.background_gain_c_per_h,
    TRUE_BACKGROUND,
    1e-3,
    'background is no longer carrying the sun',
  );
  assertClose(
    result.model.solar_gain_c_per_h_per_wm2 ?? 0,
    TRUE_SOLAR,
    1e-5,
    'solar coefficient',
  );
  assert(
    (result.model.solar_mean_w_per_m2 ?? 0) > 100,
    'the fitted mean irradiance is kept for use when no forecast arrives',
  );
});

Deno.test('without irradiance the sun hides in the constant, as it always did', () => {
  // The same room, fitted blind. This is the defect the fourth column fixes:
  // the constant lands near the *average* sun, so it over-predicts every dull
  // hour and under-predicts every bright one.
  const blind = fitThermalZone(
    sunlitSamples(1500, bandedDuty, 1000, false),
    1000,
  );
  assert(blind.ok, 'the three-regressor fit still succeeds');
  if (!blind.ok) return;
  assertEquals(
    blind.model.solar_gain_c_per_h_per_wm2 ?? null,
    null,
    'a zone fitted without irradiance has no solar term',
  );

  const meanIrradiance = Array.from({ length: 1500 }, (_u, i) => irradianceAt(i))
    .reduce((sum, value) => sum + value, 0) / 1500;
  const absorbed = TRUE_BACKGROUND + TRUE_SOLAR * meanIrradiance;
  // Least squares does not park the whole solar effect in the constant — the
  // sun correlates with the outdoor swing, so some of it leaks into the
  // cooling term instead. What is certain is the direction and the scale: the
  // constant is inflated far above the true background, and no further than
  // the average sun could carry it.
  assert(
    blind.model.background_gain_c_per_h > TRUE_BACKGROUND * 2 &&
      blind.model.background_gain_c_per_h <= absorbed,
    `the constant absorbed the average sun: ${blind.model.background_gain_c_per_h}` +
      ` should sit between ${TRUE_BACKGROUND} and ${absorbed}`,
  );

  const lit = fitThermalZone(sunlitSamples(1500, bandedDuty), 1000);
  assert(lit.ok, 'the four-regressor fit succeeds on the same room');
  if (!lit.ok) return;
  assert(
    Math.abs(lit.model.background_gain_c_per_h - TRUE_BACKGROUND) <
      Math.abs(blind.model.background_gain_c_per_h - TRUE_BACKGROUND),
    'and naming the sun brings the constant back to what it should have been',
  );
});

Deno.test('the solar term changes what a bright afternoon is predicted to do', () => {
  const lit = fitThermalZone(sunlitSamples(1500, bandedDuty), 1000);
  const blind = fitThermalZone(
    sunlitSamples(1500, bandedDuty, 1000, false),
    1000,
  );
  assert(lit.ok && blind.ok, 'both fits succeed');
  if (!lit.ok || !blind.ok) return;

  // Six hours of a clear midday, no heating, starting from the same room.
  const noon = Array.from({ length: 24 }, () => 550);
  const outdoor = new Array(24).fill(8);
  const idle = new Array(24).fill(0);
  const withSun = projectZoneTemperature(lit.model, 20, outdoor, idle, noon);
  const withoutSun = projectZoneTemperature(blind.model, 20, outdoor, idle);
  assert(
    withSun[23] - withoutSun[23] > 0.5,
    `a clear afternoon should read warmer: ${withSun[23]} vs ${withoutSun[23]}`,
  );

  // And the reverse on a dull one, which is the half that gets forgotten.
  const dark = new Array(24).fill(0);
  const withoutLight = projectZoneTemperature(lit.model, 20, outdoor, idle, dark);
  assert(
    withoutLight[23] < withoutSun[23],
    `an overcast afternoon should read cooler: ${withoutLight[23]} vs ${withoutSun[23]}`,
  );
});

Deno.test('a zone with a solar term still projects when no forecast arrives', () => {
  const lit = fitThermalZone(sunlitSamples(1500, bandedDuty), 1000);
  assert(lit.ok, 'expected a fit');
  if (!lit.ok) return;
  const outdoor = new Array(24).fill(8);
  const idle = new Array(24).fill(0);

  const atMean = projectZoneTemperature(
    lit.model,
    20,
    outdoor,
    idle,
    new Array(24).fill(lit.model.solar_mean_w_per_m2 ?? 0),
  );
  const noForecast = projectZoneTemperature(lit.model, 20, outdoor, idle);
  assertEquals(
    noForecast,
    atMean,
    'falling back to the fitted mean is exactly the flat background',
  );

  const partial = projectZoneTemperature(
    lit.model,
    20,
    outdoor,
    idle,
    [550, 550, null, null, ...new Array(20).fill(null)],
  );
  assert(
    partial[23] > noForecast[23],
    'the covered slots are used and the rest fall back, rather than all-or-nothing',
  );
});

Deno.test('sunshine that appears to cool a room is refused, not published', () => {
  // Blinds drawn on the brightest afternoons would produce this: a real
  // negative correlation that is not the physics. The zone keeps a flat
  // background rather than being rejected outright or given a cooling sun.
  const samples = sunlitSamples(1500, bandedDuty).map((sample, index) => ({
    ...sample,
    solar_w_per_m2: 600 - irradianceAt(index),
  }));
  const result = fitThermalZone(samples, 1000);
  assert(result.ok, `expected a three-regressor fallback: ${JSON.stringify(result)}`);
  if (!result.ok) return;
  assertEquals(
    result.model.solar_gain_c_per_h_per_wm2 ?? null,
    null,
    'a negative solar coefficient is dropped rather than published',
  );
  // The gain is left biased, because a dropped regressor that was really
  // driving the room has to go somewhere. That is the cost of the fallback and
  // it is the same cost the three-regressor fit always paid.
  assert(
    result.model.gain_c_per_wh > TRUE_GAIN * 0.85 &&
      result.model.gain_c_per_wh < TRUE_GAIN * 1.15,
    `gain survives, biased but physical: ${result.model.gain_c_per_wh}`,
  );
});

Deno.test('a thinly covered window fits on everything rather than on a fifth of it', () => {
  // Only the last 300 quarters carry irradiance: too few, and too small a
  // slice of the window, to represent it.
  const samples = sunlitSamples(1500, bandedDuty).map((sample, index) =>
    index < 1200 ? { ...sample, solar_w_per_m2: null } : sample
  );
  const result = fitThermalZone(samples, 1000);
  assert(result.ok, 'expected a fit over the whole window');
  if (!result.ok) return;
  assertEquals(
    result.model.solar_gain_c_per_h_per_wm2 ?? null,
    null,
    'partial coverage does not earn a solar term',
  );
  assertEquals(
    result.model.sample_count,
    1500,
    'and every usable quarter is still trained on',
  );
});
