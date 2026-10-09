// The lanes every test case is planned under, to tell apart why a plan costs
// what it does (docs/planner-bench/test-cases.md).
//
// Two things are varied, independently, and nothing else:
//
//   prices     told    the planner sees the prices published at the start and
//                      estimates the rest, as it does live.
//              oracle  the planner sees the real price of every quarter.
//   valuation  low / nominal / high: every value curve the planner derives is
//              worth 0.71x, 1x or 1.41x as much. Two steps span a factor of
//              two, about the gap between a cheap night and an ordinary day.
//
// Every lane is refereed on the original case at real prices. The base lane,
// oracle/nominal, is what the bench shows and scores: it judges how a planner
// plans, not how well it guesses prices, so every planner is given the real
// ones. The price estimate is judged on its own page (PriceEstimateAccuracy);
// the told lanes remain as diagnostics.

import type { BenchCase } from './case';

export type PriceLane = 'told' | 'oracle';
export type Variant = 'low' | 'nominal' | 'high';
export type LaneId = `${PriceLane}/${Variant}`;

export const VARIANT_SCALE: Record<Variant, number> = { low: Math.SQRT1_2, nominal: 1, high: Math.SQRT2 };
export const PRICE_LANES: PriceLane[] = ['told', 'oracle'];
export const VARIANTS: Variant[] = ['low', 'nominal', 'high'];
export const LANES: LaneId[] = PRICE_LANES.flatMap(prices => VARIANTS.map(variant => `${prices}/${variant}` as LaneId));
export const BASE_LANE: LaneId = 'oracle/nominal';

export const laneParts = (lane: LaneId) => {
  const [prices, variant] = lane.split('/') as [PriceLane, Variant];
  return { prices, variant, scale: VARIANT_SCALE[variant] };
};

/** The case as a lane's planner is told it. Refereeing always uses the original. */
export function toldCase(c: BenchCase, lane: LaneId): BenchCase {
  if (laneParts(lane).prices === 'told') return c;
  return { ...c, known_prices: { import_sek_per_kwh: [...c.recorded.prices.import_sek_per_kwh], export_sek_per_kwh: [...c.recorded.prices.export_sek_per_kwh] } };
}

/** Whether a lane's planner was given a quarter's real price, or had to estimate it. */
export const plannerKnewPrice = (lane: LaneId, published: number) => laneParts(lane).prices === 'oracle' || published === 1;

/** What a lane's result came to, as the diagnosis reads it. */
export interface LaneResult {
  /** Grid cost at real prices, SEK. */
  cost_sek: number;
  /** Value of the energy left in the stores at the end, SEK. */
  credit_sek: number;
  /** Case points: what a valuation is not allowed to cost. */
  points: number;
}

export interface Diagnosis {
  /** What the told lane's plan cost, net of what it left in the stores. */
  net_sek: number;
  /** What knowing the real prices would have saved: told/nominal's net cost minus oracle/nominal's. */
  price_estimate_sek: number;
  /** What a different valuation would have saved, with real prices known: oracle/nominal minus the best oracle variant. */
  valuation_sek: number;
  /** The variant that did best under each price lane, its points not worse than nominal's. */
  best: Record<PriceLane, Variant>;
}

const net = (r: LaneResult) => r.cost_sek - r.credit_sek;

/**
 * Split the told lane's cost into what the price estimate cost and what the
 * valuation cost. Null until every lane has a result. What is left after both,
 * against a perfect plan, is the planner's dispatch logic; the bench has no
 * perfect plan to measure that against yet.
 */
export function diagnose(byLane: Partial<Record<LaneId, LaneResult>>): Diagnosis | null {
  if (!LANES.every(lane => byLane[lane])) return null;
  const best = (prices: PriceLane): Variant => {
    const nominal = byLane[`${prices}/nominal`]!;
    return VARIANTS
      .filter(variant => byLane[`${prices}/${variant}`]!.points >= nominal.points)
      .reduce((a, b) => net(byLane[`${prices}/${b}`]!) < net(byLane[`${prices}/${a}`]!) ? b : a, 'nominal' as Variant);
  };
  const told = byLane['told/nominal']!, oracle = byLane['oracle/nominal']!;
  const bestOracle = best('oracle');
  return {
    net_sek: net(told),
    price_estimate_sek: net(told) - net(oracle),
    valuation_sek: net(oracle) - net(byLane[`oracle/${bestOracle}`]!),
    best: { told: best('told'), oracle: bestOracle },
  };
}
