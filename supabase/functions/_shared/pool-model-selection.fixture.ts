import { PoolSourceKernel } from "./planner/device-models.ts";

// Independently generated synthetic water/electricity; no recorded household data.
export const SYNTHETIC_POOL_CAPACITY = 60;
export function syntheticPoolHistory(recovery: boolean) {
  const kernel = new PoolSourceKernel(SYNTHETIC_POOL_CAPACITY, .7,
    { recovery_rate_per_h: .18, heat_loss_per_kwh: recovery ? .025 : 0 }, 4.5);
  let state = { water_c: 28, pending_heat_kwh: 2, source_depletion_kwh: 4 };
  return Array.from({ length: 21 * 96 }, (_, i) => {
    const power = i % 96 < 16 + Math.floor(i / 96) % 4 * 8 ? 3 : 0;
    const before = state.water_c;
    state = kernel.piece(before, state.pending_heat_kwh, state.source_depletion_kwh, power, 0, .25, -.02);
    return { start_ms: i * 900_000, electrical_kwh: power / 4,
      water_temperature_c: before, next_water_temperature_c: state.water_c };
  });
}

/** Recorder means of the same synthetic plant, including the next metered quarter. */
export function syntheticPoolMeanHistory(recovery: boolean) {
  const kernel = new PoolSourceKernel(SYNTHETIC_POOL_CAPACITY, .7,
    { recovery_rate_per_h: .18, heat_loss_per_kwh: recovery ? .025 : 0 }, 4.5);
  let state = { water_c: 28, pending_heat_kwh: 2, source_depletion_kwh: 4 };
  const quarters = Array.from({ length: 21 * 96 }, (_, i) => {
    const power = i % 96 < 16 + Math.floor(i / 96) % 4 * 8 ? 3 : 0;
    let sum = 0;
    for (let piece = 0; piece < 60; piece++) {
      const before = state.water_c;
      state = kernel.piece(before, state.pending_heat_kwh, state.source_depletion_kwh, power, 0, .25 / 60, -.02);
      sum += (before + state.water_c) / 2;
    }
    return { water_c: sum / 60, electrical_kwh: power / 4 };
  });
  return quarters.slice(0, -1).map((q, i) => ({ start_ms: i * 900_000,
    water_temperature_c: q.water_c, next_water_temperature_c: quarters[i + 1].water_c,
    electrical_kwh: q.electrical_kwh, next_electrical_kwh: quarters[i + 1].electrical_kwh }));
}
