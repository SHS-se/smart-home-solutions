import { assert, assertAlmostEquals, assertEquals } from "jsr:@std/assert@1";
import {
  poolCop,
  poolEnergyToTargetKwh,
  type PoolModel,
  stepPoolTemperature,
  vehicleEnergyForRangeKwh,
  vehicleKwhPerKm,
  type VehicleModel,
  vehicleRangeKm,
} from "./store-models.ts";

const pool = (): PoolModel => ({
  volume_m3: 40,
  loss_kw_per_k: 0.35,
  heat_pump: {
    rated_cop: 5,
    rated_air_c: 25,
    rated_water_c: 27,
    cop_per_air_c: 0.045,
    cop_per_water_c: -0.02,
    cutout_air_c: 8,
    rated_power_w: 3_000,
  },
});

const vehicle = (): VehicleModel => ({
  capacity_kwh: 75,
  rated_kwh_per_km: 0.16,
  rated_temperature_c: 20,
  cold_penalty_per_c: 0.014,
  max_cold_multiplier: 1.7,
  charge_efficiency: 0.9,
});

Deno.test("pool COP falls with air temperature and stops at the cut-out", () => {
  const model = pool().heat_pump;
  const warm = poolCop(model, 25, 27);
  const cool = poolCop(model, 12, 27);

  assertAlmostEquals(warm, 5, 1e-9);
  assert(cool < warm, "a colder day must deliver less heat per watt");
  assert(cool > 1, "above the cut-out the pump still beats resistive heat");
  // Below the cut-out the unit delivers nothing. Extrapolating a small COP
  // here would let the planner schedule heat that physically cannot arrive.
  assertEquals(poolCop(model, 4, 27), 0);
});

Deno.test("spring can prefer a warm afternoon over a cheap night", () => {
  const model = pool().heat_pump;
  // A cheap night at 6 °C against an expensive afternoon at 18 °C.
  const nightCop = poolCop(model, 6, 26);
  const afternoonCop = poolCop(model, 18, 26);
  const nightPrice = 0.4;
  const afternoonPrice = 0.9;

  assertEquals(nightCop, 0, "below the cut-out the night delivers no heat");
  // Effective price of delivered heat, not of electricity.
  const afternoonCost = afternoonPrice / afternoonCop;
  assert(
    afternoonCost < nightPrice,
    "delivered-heat price is what the planner should compare",
  );
});

Deno.test("a warm pool loses heat faster than a cool one", () => {
  const model = pool();
  const warmDrop = 30 - stepPoolTemperature(model, 30, 15, 0);
  const coolDrop = 22 - stepPoolTemperature(model, 22, 15, 0);

  assert(warmDrop > 0 && coolDrop > 0, "both lose heat to cooler air");
  assert(
    warmDrop > coolDrop,
    "loss scales with the water-to-air difference, so pre-heating is a trade",
  );
});

Deno.test("an already-warm pool asks for nothing", () => {
  const model = pool();
  const air = new Array(96).fill(20);

  // The defect this replaces: a median daily kWh demanded the same energy
  // every day regardless of the measured water temperature.
  assertEquals(poolEnergyToTargetKwh(model, 29, 28, air), 0);
  assert((poolEnergyToTargetKwh(model, 24, 28, air) ?? 0) > 0);
});

Deno.test("a pool the pump cannot reach reports no answer, not a plan", () => {
  const model = pool();
  const freezing = new Array(96).fill(2);

  assertEquals(
    poolEnergyToTargetKwh(model, 18, 28, freezing),
    null,
    "below the cut-out there is no schedule that reaches the target",
  );
});

Deno.test("vehicle range falls in the cold without a seasonal parameter", () => {
  const model = vehicle();
  const summer = vehicleRangeKm(model, 0.8, 20);
  const winter = vehicleRangeKm(model, 0.8, -10);

  assert(winter < summer);
  const loss = 1 - winter / summer;
  assert(
    loss > 0.25 && loss < 0.45,
    `winter range loss should land near the observed 40%, got ${
      (loss * 100).toFixed(0)
    }%`,
  );
});

Deno.test("the cold penalty is capped and one-sided", () => {
  const model = vehicle();

  assertEquals(
    vehicleKwhPerKm(model, 25),
    vehicleKwhPerKm(model, 20),
    "warmer than the rating point is not better than the rating point",
  );
  assertAlmostEquals(
    vehicleKwhPerKm(model, -60),
    model.rated_kwh_per_km * model.max_cold_multiplier,
    1e-9,
  );
});

Deno.test("charging energy accounts for losses and temperature", () => {
  const model = vehicle();
  const summer = vehicleEnergyForRangeKwh(model, 100, 200, 20);
  const winter = vehicleEnergyForRangeKwh(model, 100, 200, -10);

  assertAlmostEquals(summer, 100 * 0.16 / 0.9, 1e-9);
  assert(winter > summer, "the same 100 km costs more to store in winter");
  assertEquals(vehicleEnergyForRangeKwh(model, 200, 150, 20), 0);
});
