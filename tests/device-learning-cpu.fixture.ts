import { WATER_KWH_PER_M3_K } from "../supabase/functions/_shared/planner/device-models.ts";
import type { DeviceLearningReplayInput } from "../supabase/functions/_shared/device-learning-replay.ts";

/** Independently generated 21-day plant, never household measurements. The
 * complete loader receives 2016 quarters, including the final metered mean. */
export function syntheticPoolLearningReplay(nowMs: number, recovery = true): DeviceLearningReplayInput {
  // Independent RK4 integration avoids warming production projection code
  // before the cold handler CPU measurement. Units: hours, kW, kWh, Celsius.
  const capacity = 60, step = .25 / 60;
  let state = [28, 2, 4];
  const derivative = (s: number[], power: number) => [
    s[1] / .7 / capacity - .02,
    4.5 * power * (1 - (recovery ? .025 : 0) * s[2]) - s[1] / .7,
    power - .18 * s[2],
  ];
  const shifted = (s: number[], k: number[], h: number) => s.map((value, i) => value + k[i] * h);
  const quarters = Array.from({ length: 21 * 96 }, (_, i) => {
    const power = i % 96 < 16 + Math.floor(i / 96) % 4 * 8 ? 3 : 0;
    let sum = 0;
    for (let part = 0; part < 60; part++) {
      const before = state[0], a = derivative(state, power),
        b = derivative(shifted(state, a, step / 2), power),
        c = derivative(shifted(state, b, step / 2), power),
        d = derivative(shifted(state, c, step), power);
      state = state.map((value, j) => value + step / 6 * (a[j] + 2 * b[j] + 2 * c[j] + d[j]));
      sum += (before + state[0]) / 2;
    }
    return { c: sum / 60, kwh: power / 4 };
  });
  const start = Math.floor(nowMs / 900_000) * 900_000 - 21 * 86400_000;
  const at = (index: number) => new Date(start + index * 900_000).toISOString();
  return {
    claim: { id: "synthetic-learning", home_id: "synthetic-home", customer_id: "synthetic-customer",
      owner_kind: "pool", owner_key: "pool", generation: 1, fence: 1,
      input: { volume_m3: capacity / WATER_KWH_PER_M3_K, device_keys: ["synthetic-heater"] } },
    models: { rooms: [], pool: null },
    tables: {
      energy_optimisation_pool_model: null,
      energy_optimisation_devices: [{ id: "synthetic-heater-id" }],
      energy_optimisation_pool_slots: quarters.map((row, i) => ({ start_ts: at(i), water_temperature_c: row.c })),
      energy_optimisation_outdoor_slots: quarters.map((_, i) => ({ start_ts: at(i), temperature_c: 8 + Math.sin(i / 96) * 5 })),
      energy_optimisation_device_slots: quarters.map((row, i) => ({ start_ts: at(i), device_id: "synthetic-heater-id", energy_kwh: row.kwh })),
    },
  };
}
