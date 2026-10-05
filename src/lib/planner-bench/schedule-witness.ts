// Shared guards for independent schedule preferences, tested against the
// original plan in both the forecast and measured worlds.
import type { BenchCase, Targets } from './case';
import type { Household } from './household';
import { reachability, simulate, type Decisions, type Simulation } from './referee';
import { serviceExposure, serviceNotWorse, type Comfort, type ServiceGuard } from './service';

export type ScheduleDevice = 'pool' | 'ev' | 'battery';

export function scheduleWitness(
  c: BenchCase, h: Household, targets: Targets, original: Simulation, guard: ServiceGuard,
) {
  const reach = reachability(c, h);
  const comfort: Comfort = {
    pool_target_c: targets.pool_c, ev_target_km: targets.ev_km,
    pool_start_c: original.start.poolC, ev_start_km: original.start.evKwh / h.car.battery.kwh_per_km,
    poolReachableC: reach.poolC, carReachableKm: reach.carKm,
  };
  const exposure = (s: Simulation) => serviceExposure(comfort, s.poolC, Array.from(s.evKwh, kwh => kwh / h.car.battery.kwh_per_km), guard);
  const before = exposure(original);
  const last = c.recorded.prices.import_sek_per_kwh.length - 1;
  return (candidate: Decisions, device: ScheduleDevice, changed: number[]): Simulation | null => {
    const legal = simulate(c, h, candidate, 'told');
    if (legal.violations.length) return null;
    const after = c.recorded.actual ? simulate(c, h, candidate) : legal;
    const delivered = device === 'pool' ? after.poolW : device === 'ev' ? after.evW : after.chargeW;
    const requested = device === 'pool' ? candidate.pool_w : device === 'ev' ? candidate.ev_w : candidate.battery_charge_w;
    if (changed.some(i => Math.abs(delivered[i] - requested[i]) > 1)) return null;
    if (after.batteryKwh[last] < original.batteryKwh[last] - 1e-6
      || after.evKwh[last] < original.evKwh[last] - 1e-6
      || after.poolC[last] < original.poolC[last] - 1e-6
      || !serviceNotWorse(before, exposure(after))) return null;
    return after;
  };
}
