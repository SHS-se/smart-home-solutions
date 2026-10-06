// Apply moves cumulatively, reserving a distinct cheaper destination for each
// overlapping source quarter; never award one point per pair.
import type { BenchCase, Targets } from './case';
import type { Household } from './household';
import { evLevels, evMaxW, simulate, type Decisions, type Simulation } from './referee';
import type { ServiceGuard } from './service';
import { scheduleWitness } from './schedule-witness';
import { stepMove } from './step-moves';

export const LARGE_WORKLOAD_W = 2000;
type Device = 'ev' | 'battery';
export interface OverlapMove { from: number; to: number; device: Device; movedW: number }
export interface LargeLoadOverlapAudit { thresholdW: number; overlappingQuarters: number[]; moves: OverlapMove[] }

export function auditLargeLoadOverlap(
  c: BenchCase, h: Household, targets: Targets, d: Decisions, original: Simulation,
  guard: ServiceGuard, thresholdW: number,
): LargeLoadOverlapAudit {
  const fields = { ev: 'ev_w', battery: 'battery_charge_w' } as const;
  const deliveredFields = { ev: 'evW', battery: 'chargeW' } as const;
  const devices: Device[] = ['ev', 'battery'];
  // Pool heating contributes to overlap, but its heating cycle stays fixed.
  const overlapping = d.pool_w.flatMap((pool, i) =>
    [pool, d.ev_w[i], d.battery_charge_w[i]].filter(w => w > thresholdW).length >= 2 ? [i] : []);
  const out: LargeLoadOverlapAudit = { thresholdW, overlappingQuarters: overlapping, moves: [] };
  if (!overlapping.length) return out;
  const prices = c.recorded.prices.import_sek_per_kwh;
  const cheapest = prices.map((_, i) => i).sort((a, b) => prices[a] - prices[b] || a - b);
  const witness = scheduleWitness(c, h, targets, original, guard);
  let booked = d;
  let measured = original;
  let told = c.recorded.actual ? simulate(c, h, d, 'told') : original;
  const destinations = new Set<number>();

  for (const from of overlapping) {
    search: for (const to of cheapest) {
      if (prices[to] >= prices[from]) break;
      if (destinations.has(to)) continue;
      for (const device of devices) {
        const values = booked[fields[device]];
        if (values[from] <= thresholdW) continue;
        const headroom = Math.max(0, h.site.import_limit_w - told.netW[to]);
        const cap = device === 'ev' ? evMaxW(h) : h.battery.charge_max_w;
        let want = Math.min(values[from], cap - values[to], headroom);
        if (device === 'battery') {
          // A moved charge changes inventory only between its old and new quarter.
          // Limit the transfer by the tightest intervening storage margin in both worlds.
          for (const state of c.recorded.actual ? [measured, told] : [measured]) {
            for (let i = Math.min(from, to); i < Math.max(from, to); i++) {
              const margin = to < from ? h.battery.max_soc * h.battery.capacity_kwh - state.batteryKwh[i]
                : state.batteryKwh[i] - h.battery.min_soc * h.battery.capacity_kwh;
              want = Math.min(want, Math.max(0, margin) * 1000 / (h.battery.charge_efficiency * 0.25));
            }
          }
        }
        if (want <= 0) continue;
        // Charger amps stay whole; battery charging is continuous.
        const levels = device === 'ev' ? evLevels(h) : null;
        const powers = levels
          ? levels.map(level => values[from] - level.draw_w).filter(w => w > 0 && w <= want + 1e-6).sort((a, b) => b - a)
          : [want];
        for (const power of powers) {
          const move = levels ? stepMove(values, [from], [to], levels, power) : null;
          if (levels && !move) continue;
          const shifted = move?.values ?? [...values];
          if (!levels) { shifted[from] -= power; shifted[to] += power; }
          const candidate = { ...booked, [fields[device]]: shifted };
          const after = witness(candidate, device, [from, to]);
          if (!after) continue;
          // Later edits must not curtail any earlier accepted booking in the
          // measured world, including bookings belonging to another device.
          if (out.moves.some(m => [m.from, m.to].some(i =>
            Math.abs(after[deliveredFields[m.device]][i] - candidate[fields[m.device]][i]) > 1))) continue;
          out.moves.push({ from, to, device, movedW: move?.moved_w ?? power });
          destinations.add(to);
          booked = candidate;
          measured = after;
          told = c.recorded.actual ? simulate(c, h, booked, 'told') : after;
          break search;
        }
      }
    }
  }
  return out;
}
