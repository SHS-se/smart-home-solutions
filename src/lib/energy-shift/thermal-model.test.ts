import {
  fitThermalZone,
  projectZoneTemperature,
  quarterEnergyToWatts,
  SLOT_HOURS,
  solveLinearSystem,
  type ThermalTrainingSample,
  type ThermalZoneModel,
} from '../../../supabase/functions/_shared/thermal-model.ts';

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

Deno.test('fitThermalZone refuses a zone whose heater never ran', () => {
  // With no heat input the gain column is all zeros, so the parameter is
  // unidentifiable rather than merely uncertain.
  const result = fitThermalZone(syntheticSamples(1000, () => 0), 1000);
  assert(!result.ok, 'an unheated zone cannot identify a heating gain');
  if (result.ok) return;
  assertEquals(result.reason, 'singular', 'rejection reason');
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
