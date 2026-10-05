// Short interruptions at similar prices are a scheduling preference, not a
// claim of bill savings. A witness joins adjacent runs with the same booked
// energy, keeping legal device levels, service and final inventories.
import type { BenchCase, Targets } from './case';
import type { Household } from './household';
import { evLevels, poolLevels, type Decisions, type Simulation } from './referee';
import { scheduleWitness } from './schedule-witness';
import type { ServiceGuard } from './service';

export const SHORT_GAP_MAX_QUARTERS = 4;
export const SHORT_GAP_PRICE_TOLERANCE = 0.05;
export type GapDevice = 'pool' | 'ev';
export interface ShortGap { device: GapDevice; from: number; /** Exclusive: the restart quarter. */ to: number }
export interface GapChange { quarter: number; beforeW: number; afterW: number }
export interface ShortGapWitness extends ShortGap { changes: GapChange[] }
export interface ShortGapAudit {
  priceTolerance: Record<GapDevice, number>;
  /** All bracketed 1–4-quarter gaps, before the price and feasibility checks. */
  candidates: ShortGap[];
  gaps: ShortGapWitness[];
}

export function auditShortGaps(
  c: BenchCase, h: Household, targets: Targets, d: Decisions, original: Simulation,
  guard: ServiceGuard, priceTolerance: Record<GapDevice, number>,
): ShortGapAudit {
  const out: ShortGapAudit = { priceTolerance: { ...priceTolerance }, candidates: [], gaps: [] };
  const witness = scheduleWitness(c, h, targets, original, guard);
  const prices = c.recorded.prices.import_sek_per_kwh;
  for (const device of ['pool', 'ev'] as const) {
    const key = device === 'pool' ? 'pool_w' : 'ev_w';
    const values = d[key];
    const levels = (device === 'pool' ? poolLevels(h) : evLevels(h)).filter(l => l.draw_w > 0);
    if (!levels.length) continue;
    const min = levels[0].draw_w;
    for (let from = 1; from < values.length; from++) {
      if (values[from] !== 0 || values[from - 1] <= 0) continue;
      let to = from;
      while (to < values.length && values[to] === 0) to++;
      const length = to - from;
      if (to === values.length || length > SHORT_GAP_MAX_QUARTERS) continue;
      const gap = { device, from, to };
      out.candidates.push(gap);
      if (prices.slice(from, to).some(p => Math.abs(p - prices[from - 1]) > priceTolerance[device] + 1e-9
        || Math.abs(p - prices[to]) > priceTolerance[device] + 1e-9)) continue;
      let left = from - 1, right = to + 1;
      while (left > 0 && values[left - 1] > 0) left--;
      while (right < values.length && values[right] > 0) right++;
      // Try retaining both runs first, then trimming only their outer edges.
      // At most one edge quarter per gap quarter needs to be removed. Two
      // donor orders expose alternatives that protect early service or stores.
      search: for (let trim = 0; trim <= length; trim++) {
        for (let trimLeft = 0; trimLeft <= trim; trimLeft++) {
          const trimRight = trim - trimLeft;
          if (trimLeft > from - left || trimRight > right - to) continue;
          const start = left + trimLeft, end = right - trimRight;
          for (const reverse of [false, true]) {
            const shifted = [...values];
            for (let i = left; i < right; i++) shifted[i] = i < start || i >= end ? 0 : values[i] || min;
            let excess = shifted.slice(left, right).reduce((sum, w, i) => sum + w - values[left + i], 0);
            const order = Array.from({ length: end - start }, (_, i) => start + i);
            if (reverse) order.reverse();
            for (const i of order) {
              if (Math.abs(excess) < 1e-6) break;
              const choices = levels.filter(l => excess > 0
                ? l.draw_w <= shifted[i] && shifted[i] - l.draw_w <= excess + 1e-6
                : l.draw_w >= shifted[i] && l.draw_w - shifted[i] <= -excess + 1e-6);
              if (!choices.length) continue;
              const power = excess > 0 ? choices[0].draw_w : choices.at(-1)!.draw_w;
              excess -= shifted[i] - power;
              shifted[i] = power;
            }
            if (Math.abs(excess) > 1e-6) continue;
            const changes = shifted.flatMap((afterW, quarter) => Math.abs(afterW - values[quarter]) > 1e-6
              ? [{ quarter, beforeW: values[quarter], afterW }] : []);
            if (!witness({ ...d, [key]: shifted }, device, changes.map(change => change.quarter))) continue;
            out.gaps.push({ ...gap, changes });
            break search;
          }
        }
      }
    }
  }
  return out;
}
