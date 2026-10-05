// A quarter is filled only when another legal booking cannot fit there.
// Test cheaper quarters in price order against the original schedule; keep
// one feasible witness per overlapping quarter, never one point per pair.
import type { BenchCase, Targets } from './case';
import type { Household } from './household';
import { evLevels, evMaxW, poolLevels, simulate, type Decisions, type Simulation } from './referee';
import type { ServiceGuard } from './service';
import { scheduleWitness } from './schedule-witness';
import { stepMove } from './step-moves';

export const LARGE_WORKLOAD_W = 2000;
type Device = 'pool' | 'ev' | 'battery';
export interface OverlapMove { from: number; to: number; device: Device; movedW: number }
export interface LargeLoadOverlapAudit { thresholdW: number; overlappingQuarters: number[]; moves: OverlapMove[] }

export function auditLargeLoadOverlap(
  c: BenchCase, h: Household, targets: Targets, d: Decisions, original: Simulation,
  guard: ServiceGuard, thresholdW: number,
): LargeLoadOverlapAudit {
  const streams = { pool: d.pool_w, ev: d.ev_w, battery: d.battery_charge_w };
  const devices: Device[] = ['pool', 'ev', 'battery'];
  const overlapping = d.pool_w.flatMap((_, i) => devices.filter(device => streams[device][i] > thresholdW).length >= 2 ? [i] : []);
  const out: LargeLoadOverlapAudit = { thresholdW, overlappingQuarters: overlapping, moves: [] };
  if (!overlapping.length) return out;
  const prices = c.recorded.prices.import_sek_per_kwh;
  const cheapest = prices.map((_, i) => i).sort((a, b) => prices[a] - prices[b] || a - b);
  const witness = scheduleWitness(c, h, targets, original, guard);
  const told = c.recorded.actual ? simulate(c, h, d, 'told') : original;

  for (const from of overlapping) {
    search: for (const to of cheapest) {
      if (prices[to] >= prices[from]) break;
      for (const device of devices) {
        const values = streams[device];
        if (values[from] <= thresholdW) continue;
        const headroom = Math.max(0, h.site.import_limit_w - told.netW[to]);
        const cap = device === 'pool' ? poolLevels(h).at(-1)!.draw_w : device === 'ev' ? evMaxW(h) : h.battery.charge_max_w;
        let want = Math.min(values[from], cap - values[to], headroom);
        if (device === 'battery') {
          // A moved charge changes inventory only between its old and new quarter.
          // Limit the transfer by the tightest intervening storage margin in both worlds.
          for (const state of c.recorded.actual ? [original, told] : [original]) {
            for (let i = Math.min(from, to); i < Math.max(from, to); i++) {
              const margin = to < from ? h.battery.max_soc * h.battery.capacity_kwh - state.batteryKwh[i]
                : state.batteryKwh[i] - h.battery.min_soc * h.battery.capacity_kwh;
              want = Math.min(want, Math.max(0, margin) * 1000 / (h.battery.charge_efficiency * 0.25));
            }
          }
        }
        if (want <= 0) continue;
        // Whole heater quarters and charger amps; battery charging is continuous.
        const levels = device === 'pool' ? poolLevels(h) : device === 'ev' ? evLevels(h) : null;
        const powers = levels
          ? levels.map(level => values[from] - level.draw_w).filter(w => w > 0 && w <= want + 1e-6).sort((a, b) => b - a)
          : [want];
        for (const power of powers) {
          const move = levels ? stepMove(values, [from], [to], levels, power) : null;
          if (levels && !move) continue;
          const shifted = move?.values ?? [...values];
          if (!levels) { shifted[from] -= power; shifted[to] += power; }
          const candidate = { ...d, [device === 'pool' ? 'pool_w' : device === 'ev' ? 'ev_w' : 'battery_charge_w']: shifted };
          if (!witness(candidate, device, [from, to])) continue;
          out.moves.push({ from, to, device, movedW: move?.moved_w ?? power });
          break search;
        }
      }
    }
  }
  return out;
}
