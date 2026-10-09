// A charge bought from the grid with a clearly cheaper quarter still ahead of
// it. A witness moves the bought power to that quarter against the schedule
// the earlier moves left, so one cheap quarter takes as many earlier charges
// as it has power for. Every alternative keeps service and every final store,
// and may not cost more than the schedule it changes.
import type { BenchCase, Targets } from './case';
import type { Household } from './household';
import { evLevels, evMaxW, HOURS, simulate, type Decisions, type Simulation } from './referee';
import { scheduleWitness } from './schedule-witness';
import type { ServiceGuard } from './service';
import { stepMove } from './step-moves';

export const EARLY_CHARGE_PRICE_TOLERANCE = 0.1;
export const EARLY_CHARGE_PRICE_FRACTION = 0.1;
/** Charging that draws at least this from the grid is a purchase to judge, W; the flexible-load floor (FLEXIBLE_W, score.ts). */
export const EARLY_CHARGE_GRID_W = 500;
/** How much cheaper the later quarter must be: the configured minimum, or 10% of the charging quarter's absolute price. */
export const earlyChargePriceMargin = (price: number, minimum: number) =>
  Math.max(minimum, EARLY_CHARGE_PRICE_FRACTION * Math.abs(price));

type Device = 'ev' | 'battery';
export interface EarlyCharge { quarter: number; device: Device; /** Charging power drawn from the grid, W. */ boughtW: number }
export interface EarlyChargeMove { from: number; to: number; device: Device; movedW: number }
export interface EarlyChargeAudit {
  /** The configured minimum; each charging quarter also allows 10% of its absolute price. */
  priceTolerance: number;
  /** Every quarter charging bought at least EARLY_CHARGE_GRID_W, before the price and feasibility checks. */
  candidates: EarlyCharge[];
  moves: EarlyChargeMove[];
}

export function auditEarlyCharge(
  c: BenchCase, h: Household, targets: Targets, d: Decisions, original: Simulation,
  guard: ServiceGuard, priceTolerance: number,
): EarlyChargeAudit {
  const fields = { ev: 'ev_w', battery: 'battery_charge_w' } as const;
  const deliveredFields = { ev: 'evW', battery: 'chargeW' } as const;
  const devices: Device[] = ['battery', 'ev'];
  /** A device's charging power met by the grid: no more than the quarter imports. */
  const bought = (s: Simulation, device: Device, i: number) => Math.min(s[deliveredFields[device]][i], Math.max(0, s.netW[i]));
  const out: EarlyChargeAudit = { priceTolerance, candidates: [], moves: [] };
  const prices = c.recorded.prices.import_sek_per_kwh;
  for (let i = 0; i < prices.length; i++) {
    for (const device of devices) {
      const boughtW = bought(original, device, i);
      if (boughtW >= EARLY_CHARGE_GRID_W) out.candidates.push({ quarter: i, device, boughtW: Math.round(boughtW * 10) / 10 });
    }
  }
  if (!out.candidates.length) return out;
  const witness = scheduleWitness(c, h, targets, original, guard);
  const wearRate = h.site.battery_degradation_sek_per_kwh;
  const bill = (s: Simulation) => s.cost + wearRate * s.dischargeW.reduce((sum, w) => sum + w, 0) * HOURS / 1_000;
  let booked = d;
  let measured = original;
  let told = c.recorded.actual ? simulate(c, h, d, 'told') : original;

  for (const { quarter: from, device, boughtW } of out.candidates) {
    const margin = earlyChargePriceMargin(prices[from], priceTolerance);
    const later = prices.map((_, i) => i).filter(i => i > from && prices[i] < prices[from] - margin - 1e-9)
      .sort((a, b) => prices[a] - prices[b] || a - b);
    search: for (const to of later) {
      const values = booked[fields[device]];
      // A battery told to discharge in the cheaper quarter is not charged there as well.
      if (device === 'battery' && booked.battery_discharge_w[to] > 0) continue;
      const headroom = Math.max(0, h.site.import_limit_w - told.netW[to]);
      const cap = device === 'ev' ? evMaxW(h) : h.battery.charge_max_w;
      let want = Math.min(values[from], cap - values[to], headroom);
      if (device === 'battery') {
        // A charge moved later leaves the battery emptier until then, in both worlds.
        for (const state of c.recorded.actual ? [measured, told] : [measured]) {
          for (let i = from; i < to; i++) {
            const stored = state.batteryKwh[i] - h.battery.min_soc * h.battery.capacity_kwh;
            want = Math.min(want, Math.max(0, stored) * 1000 / (h.battery.charge_efficiency * HOURS));
          }
        }
      }
      // The cheaper quarter must take all that was bought.
      if (want < boughtW - 1) continue;
      // Charger amps stay whole, so the car moves the least that covers the purchase; battery charging is continuous.
      const levels = device === 'ev' ? evLevels(h) : null;
      const powers = levels
        ? levels.map(level => values[from] - level.draw_w).filter(w => w >= boughtW - 1 && w <= want + 1e-6).sort((a, b) => a - b)
        : [boughtW];
      for (const power of powers) {
        const move = levels ? stepMove(values, [from], [to], levels, power) : null;
        if (levels && (!move || move.moved_w < boughtW - 1)) continue;
        const shifted = move?.values ?? [...values];
        if (!levels) { shifted[from] -= power; shifted[to] += power; }
        const candidate = { ...booked, [fields[device]]: shifted };
        const after = witness(candidate, device, [to]);
        // All the plan bought here has left the quarter; what an earlier move put in it may stay.
        if (!after || bought(after, device, from) > bought(measured, device, from) - boughtW + 1) continue;
        // Later edits must not curtail an earlier accepted booking in the measured world.
        if (out.moves.some(m => Math.abs(after[deliveredFields[m.device]][m.to] - candidate[fields[m.device]][m.to]) > 1)) continue;
        if (bill(after) > bill(measured) + 1e-9) continue;
        out.moves.push({ from, to, device, movedW: Math.round((move?.moved_w ?? power) * 10) / 10 });
        booked = candidate;
        measured = after;
        told = c.recorded.actual ? simulate(c, h, booked, 'told') : after;
        break search;
      }
    }
  }
  return out;
}
