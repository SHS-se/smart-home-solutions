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
