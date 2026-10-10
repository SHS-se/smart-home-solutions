import { poolBeforeC, thermalBufferTrace, type BufferQuarter } from './thermal-buffer';
// Scoring a plan, and the run score built from it.
//
// A case has one score, and a point of it is a krona:
//
//   points = deductions − net bill
//   net bill = grid cost + battery wear + pool-start wear − the energy left in the stores
//
// The net bill is the referee's (referee.ts billOf): purchases less export
// revenue at real prices, wear on what the battery discharged and 3 kr per pool
// heater start, and a credit
// for the energy each store ends with beyond its start, up to its target, at
// the case's median price (end-credit.ts). It is the same for every rule
// setting. Higher is better; a score is comparable between planners on one
// case, not between cases, and a run's score is the sum of its cases'.
//
//   Deductions. Each quarter loses the points of every deduction rule that
//     fires in it, in whole kronor. Comfort is measured from the owner's
//     target: the pool more than 1 °C below it, and again when more than 2 °C
//     below; the car more than 50 km short, and again when more than 100 km
//     short. Such a rule cannot fire until its level was reachable: where full
//     power from the first quarter would have got the store there, plus a day
//     to choose the hours. A pool heated past its target + 2 °C, or held there
//     with the next day neither dearer nor duller, loses a point. A heater
//     restarted within 12 hours of stopping loses two at the restart. A pause
//     of one to four quarters in pool heating is charged once, by that restart
//     rule; only where the restart rule does not charge it does the gap rule,
//     a point per quarter when a continuous run is proven possible. A pause in
//     car charging takes nothing. Home-battery power reaching the car loses a
//     point.
//
//   Evidence. The price rules (cheap and dear quarters, dear base-load
//     imports, missed cheap quarters, high-sale arbitrage, large workloads
//     together, grid charges before a clearly cheaper quarter, the warm
//     buffer) are still measured and drawn, and listed per quarter as noted.
//     They take and give no points: what they describe is on the bill. The
//     energy-timing audit (opportunities.ts) likewise proves, in kronor, what
//     moving energy in time would have saved.
//
// Apart from points, a plan that asks for what the household cannot do
// (referee.ts) fails the case, whatever its points; a plan whose audit could
// not be made is failed the same way, not given invented points.
//
// Scoring reads only the stored plan series, bill and audit included, so the
// page can preview points and enabled changes without replaying anything.
// Threshold changes that need new witnesses are marked pending. A stored score
// is never made without its audit and its bill.
//
// Bump SCORER_VERSION whenever a rule or default changes, so stored scores
// are recognised as stale and recomputed.

import { OPPORTUNITY_AUDIT_VERSION, summariseAudit, type OpportunityAudit, type OpportunityAuditSummary } from './opportunities';
import { dueFrom, evExposure, poolExposure, storeNotWorse, type ServiceGuard } from './service';
import type { BenchSeries, Bill, CriteriaOverrides, Verdict } from './types';
import { baseLoadGridSupplyW, flexibleGridSupplyW, evBatterySupplyW } from './supply';
import { SHORT_GAP_PRICE_FRACTION } from './short-gaps';
import { EARLY_CHARGE_GRID_W, EARLY_CHARGE_PRICE_FRACTION } from './early-charge';
import { canonicalJson } from './case';
import { criteriaErrors, CriteriaError, ruleDefaults, REMOVED_RULE_KEYS, type RuleRole } from '../../../supabase/functions/_shared/planner-wasm/rule-policy';
export { criteriaErrors, CriteriaError, RULE_POINTS_MIN, RULE_POINTS_MAX, REMOVED_RULE_KEYS, type RuleRole } from '../../../supabase/functions/_shared/planner-wasm/rule-policy';

export { flexibleGridSupplyW, evBatterySupplyW } from './supply';
export { GRACE_QUARTERS } from './service';

export const SCORER_VERSION = 31;
/** The most a rule may take from a quarter, and the most it may give. */
/** A plan day: the pool's warmth is judged against the 24 hours after the 24 it is in. */
export const DAY_QUARTERS = 96;
/** How much dearer, or how much less sunny, the next day must be to be worth storing heat for. */
export const AHEAD_MARGIN = 0.1;
/** Pool, battery charging and car together at or above this count as a flexible purchase. */
export const FLEXIBLE_W = 500;
/** The flexible load a quarter needs for the very cheap reward, W. */
export const VERY_CHEAP_FLEXIBLE_W = 1000;
/** The home battery's target for taking a cheap charging opportunity, percent SOC. */
export const CHEAP_CHARGE_BATTERY_SOC = 100;
/** Sale-price threshold for the two arbitrage preferences, SEK/kWh. */
export const ARBITRAGE_SALE_PRICE = 4;

/** What a rule can see about one quarter. */
export interface QuarterView {
  s: BenchSeries;
  i: number;
  /** Share of the plan's quarters priced strictly below this one, 0-1. */
  priceRank: number;
  /** The cheap rule also counts this quarter: its share stretched along a valley (stretchedValleys). */
  cheapValley: boolean;
  /** Share of the plan's quarters priced strictly above this one, 0-1. */
  dearRank: number;
  /** Pool heating below its enabled overheating threshold + battery charging + car, W. */
  rewardingFlexibleW: number;
  /** Flexible demand left after battery supply, capped by actual grid imports, W. */
  flexibleGridW: number;
  /** The battery can cover all grid-attributed base load in this quarter. */
  baseLoadCoverable: boolean;
  /** The plan's next day against this one; null in the last day, which has none to compare with. */
  ahead: { dearer: boolean; lessSun: boolean } | null;
  thermalBuffer: boolean;
  /** Whether a level was reachable long enough ago for missing it to count. */
  due: (reachable: readonly number[] | undefined, start: number, level: number) => boolean;
  /** A legal cheaper-quarter move exists for one of this quarter's large bookings. */
  avoidableOverlap: boolean;
  /** An avoidable short gap in pool heating includes this quarter. */
  shortPoolGap: boolean;
  /** Charging bought from the grid here has a proven move to a clearly cheaper later quarter. */
  earlyGridCharge: boolean;
  /** Home-battery power left for EV charging after exports and other household loads, W. */
  evBatteryW: number;
  /** The last charge before the first high-sale quarter ended full, or the case started full without a later charge. */
  arbitragePrepared: boolean;
}

export interface QuarterRule {
  key: string;
  label: string;
  describe: (threshold: number) => string;
  threshold: number;
  /** Signed points (kronor) a deduction takes when it fires; an evidence rule's are what it once counted, shown and not scored. */
  points: number;
  /** Whether the rule takes points, or is measured and noted only (rule-policy.ts). */
  role: RuleRole;
  /** What the rule measures, for explaining it; nothing in the scoring depends on it. */
  about: 'pool' | 'car' | 'price';
  /** Does not fire in a quarter where this other rule fired, so the two never stack. */
  unless?: string;
  /** A case in which this rule fires anywhere is shown as failed. */
  required?: boolean;
  fires: (q: QuarterView, threshold: number) => boolean;
  /** The first quarter in which the rule could fire; Infinity when it never can. */
  eligibleFrom: (s: BenchSeries, threshold: number) => number;
}

const poolBelow = (q: QuarterView, t: number) => {
  const c = q.s.comfort, now = q.s.poolC[q.i];
  return !!c && now !== null && now < c.pool_target_c - t && q.due(c.poolReachableC, c.pool_start_c, c.pool_target_c - t);
};
const carBelow = (q: QuarterView, t: number) => {
  const c = q.s.comfort, km = q.s.carKm;
  return !!c && !!km && km[q.i] < c.ev_target_km - t && q.due(c.carReachableKm, c.ev_start_km, c.ev_target_km - t);
};
const poolAbove = (q: QuarterView, t: number) =>
  !!q.s.comfort && q.s.poolC[q.i] !== null && q.s.poolC[q.i]! > q.s.comfort.pool_target_c + t;
const poolAny = (s: BenchSeries) => s.comfort && s.poolC.some(v => v !== null) ? 0 : Infinity;
const poolFrom = (s: BenchSeries, t: number) =>
  s.comfort && s.poolC.some(v => v !== null) ? dueFrom(s.comfort.poolReachableC, s.comfort.pool_start_c, s.comfort.pool_target_c - t) : Infinity;
const carFrom = (s: BenchSeries, t: number) =>
  s.comfort && s.carKm ? dueFrom(s.comfort.carReachableKm, s.comfort.ev_start_km, s.comfort.ev_target_km - t) : Infinity;

const pct = (t: number) => `${Math.round(t * 100)} %`;

/**
 * How far the cheap share may stretch along a valley: 25 % reaches 32.5 %.
 * The planner kernel applies the same stretch (`PRICE_BRIDGE_STRETCH`, planner-core policy.rs).
 */
export const PRICE_BRIDGE_STRETCH = 1.3;
/** The shortest valley the stretch applies to, in quarters, before stretching. */
export const PRICE_BRIDGE_MIN_QUARTERS = 8;
/**
 * The quarters the cheap share reaches by stretching its valleys. A fixed
 * share cuts through a wave of prices, and quarters a hair over the line split
 * one valley into runs too short to use. A valley is an unbroken run of
 * PRICE_BRIDGE_MIN_QUARTERS or more quarters in the share. It stretches
 * through every adjoining quarter within PRICE_BRIDGE_STRETCH times the share,
 * so it grows at both ends and joins what lies within reach. A quarter beyond
 * the stretch ends it; shorter runs in the share stay as they were.
 */
export function stretchedValleys(rank: readonly number[], share: number): boolean[] {
  const n = rank.length, reach = share * PRICE_BRIDGE_STRETCH;
  const valley = new Array<boolean>(n).fill(false);
  for (let from = 0; from < n; from++) {
    let to = from, run = 0, longest = 0;
    for (; to < n && rank[to] < reach; to++) {
      run = rank[to] < share ? run + 1 : 0;
      longest = Math.max(longest, run);
    }
    if (longest >= PRICE_BRIDGE_MIN_QUARTERS) valley.fill(true, from, to);
    from = to;
  }
  return valley;
}
const cheapShare = (t: number) =>
  `price in cheapest ${pct(t)}, or up to ${+(t * PRICE_BRIDGE_STRETCH * 100).toFixed(1)} % in an unbroken run adjoining at least ${PRICE_BRIDGE_MIN_QUARTERS} consecutive quarters in the cheapest ${pct(t)}`;
const poolHeatingPast = (q: QuarterView, threshold: number) => {
  const before = poolBeforeC(q.s, q.i);
  return !!q.s.comfort && before !== null && before >= q.s.comfort.pool_target_c + threshold
    && (q.s.poolW[q.i] > 0 || !!q.s.poolStart?.[q.i]);
};
const cheapBuy = (q: QuarterView, t: number) => q.rewardingFlexibleW >= FLEXIBLE_W && (q.priceRank < t || q.cheapValley);
const cheapestBuy = (q: QuarterView, t: number) => q.rewardingFlexibleW >= VERY_CHEAP_FLEXIBLE_W && q.priceRank < t;
const dearBuy = (q: QuarterView, t: number) => q.flexibleGridW >= FLEXIBLE_W && q.dearRank < t;
const baseLoadDearBuy = (q: QuarterView, t: number) => q.baseLoadCoverable && q.dearRank < t;

const missedCheapQuarter = (q: QuarterView, price: number) => {
  if (q.s.importPrice[q.i] >= price) return false;
  const s = q.s, i = q.i, c = s.comfort;
  const devices = [
    { below: s.homeSoc[i] !== null && s.homeSoc[i] < CHEAP_CHARGE_BATTERY_SOC, watts: s.batteryChargeW[i] },
    { below: !!c && !!s.carKm && s.carKm[i] < c.ev_target_km, watts: s.carW[i] },
    { below: !!c && s.poolC[i] !== null && s.poolC[i] < c.pool_target_c, watts: s.poolW[i] },
  ];
  return devices.some(device => device.below) && !devices.some(device => device.watts >= FLEXIBLE_W);
};

/** Preparation is fixed before the first opportunity for the entire case, including separated later spikes. */
export function arbitragePreparation(s: BenchSeries, salePrice: number): {
  firstQuarter: number; lastChargeQuarter: number | null; prepared: boolean;
} {
  const firstQuarter = s.exportPrice.findIndex(price => price > salePrice);
  let lastChargeQuarter: number | null = null;
  for (let i = 0; i < firstQuarter; i++) {
    if (s.batteryChargeW[i] > 0) lastChargeQuarter = i;
  }
  const soc = lastChargeQuarter === null ? s.homeStartSoc : s.homeSoc[lastChargeQuarter];
  return { firstQuarter, lastChargeQuarter, prepared: firstQuarter >= 0 && soc !== null && soc >= 100 };
}

const QUARTER_RULES: Omit<QuarterRule, "threshold" | "points" | "role" | "required" | "unless">[] = [
  {
    key: 'pool_low', about: 'pool', label: 'Pool below target', describe: t => `more than ${t} °C below`, fires: poolBelow, eligibleFrom: poolFrom,
  },
  {
    key: 'pool_cold', about: 'pool', label: 'Pool far below target', describe: t => `more than ${t} °C below`, fires: poolBelow, eligibleFrom: poolFrom,
  },
  // Warm water is a store. Above the target it is one or the other: heat kept for a dearer or duller day, or waste.
  {
    key: 'pool_hot', about: 'pool', label: 'Pool overheated', describe: t => `heating after reaching target +${t} °C, or warmer than that with the next day neither dearer nor less sunny`,
    fires: (q, t) => poolHeatingPast(q, t) || poolAbove(q, t) && !!q.ahead && !q.ahead.dearer && !q.ahead.lessSun, eligibleFrom: poolAny,
  },
  {
    key: 'pool_buffer', about: 'pool', label: 'Warm thermal buffer', describe: t => `reaching target +${t} °C, then coasting above it with heating off, in one consecutive episode per heating cycle and future reheating event; high prices or low solar in May–September`, fires: q => q.thermalBuffer, eligibleFrom: poolAny,
  },
  {
    key: 'pool_restart', about: 'pool', label: 'Pool heater restarted too soon',
    describe: t => `started less than ${t} hours after its last stop; only the starting quarter counts`,
    fires: (q, t) => {
      const start = q.s.poolStart?.[q.i];
      return start !== null && start !== undefined && start.off_seconds !== null && start.off_seconds < t * 3600;
    },
    eligibleFrom: s => s.poolStart?.length === s.start.length ? 0 : Infinity,
  },
  {
    key: 'ev_low', about: 'car', label: 'Car short of target range', describe: t => `more than ${t} km short`, fires: carBelow, eligibleFrom: carFrom,
  },
  {
    key: 'ev_short', about: 'car', label: 'Car far short of target range', describe: t => `more than ${t} km short`, fires: carBelow, eligibleFrom: carFrom,
  },
  {
    key: 'cheap_buy', about: 'price', label: 'Flexible load in a cheap quarter', describe: t => `${cheapShare(t)}; pool heating after the overheating threshold earns no cheap-load credit`, fires: cheapBuy, eligibleFrom: () => 0,
  },
  {
    key: 'cheapest_buy', about: 'price', label: 'Flexible load in a very cheap quarter', describe: t => `price in cheapest ${pct(t)} and at least ${VERY_CHEAP_FLEXIBLE_W} W of that load; pool heating after the overheating threshold earns no cheap-load credit`, fires: cheapestBuy, eligibleFrom: () => 0,
  },
  {
    key: 'dear_load', about: 'price', label: 'Flexible load bought in a dear quarter', describe: t => `price in dearest ${pct(t)}`, fires: dearBuy, eligibleFrom: () => 0,
  },
  {
    key: 'dearest_load', about: 'price', label: 'Flexible load bought in a very dear quarter', describe: t => `price in dearest ${pct(t)}`, fires: dearBuy, eligibleFrom: () => 0,
  },
  {
    key: 'base_load_dear_import', about: 'price', label: 'Dear base-load import the battery could cover',
    describe: t => `price in dearest ${pct(t)}, battery can cover all imported base load of at least ${FLEXIBLE_W} W`,
    fires: baseLoadDearBuy, eligibleFrom: () => 0,
  },
  {
    key: 'base_load_dearest_import', about: 'price', label: 'Very dear base-load import the battery could cover',
    describe: t => `price in dearest ${pct(t)}, battery can cover all imported base load of at least ${FLEXIBLE_W} W`,
    fires: baseLoadDearBuy, eligibleFrom: () => 0,
  },
  {
    key: 'missed_cheap_quarter', about: 'price', label: 'Missed cheap charging or heating quarter',
    describe: t => `purchase price below ${t} SEK/kWh, a flexible store below target, and no charging or pool heating drawing at least ${FLEXIBLE_W} W`,
    fires: missedCheapQuarter, eligibleFrom: () => 0,
  },
  {
    key: 'arbitrage_no_export', about: 'price', label: 'No export during a high sale-price quarter',
    describe: t => `sale price above ${t} SEK/kWh and no energy exported to the grid`,
    fires: (q, t) => q.s.exportPrice[q.i] > t && q.s.gridExportW[q.i] <= 0,
    eligibleFrom: () => 0,
  },
  {
    key: 'arbitrage_not_full', about: 'price', label: 'Battery not fully charged before arbitrage',
    describe: t => `sale price above ${t} SEK/kWh and the last charge before the first opportunity did not finish at 100% SOC`,
    fires: (q, t) => q.s.exportPrice[q.i] > t && !q.arbitragePrepared,
    eligibleFrom: () => 0,
  },
  {
    key: 'large_load_overlap', about: 'price', label: 'Large workloads overlap with cheaper capacity available',
    describe: t => `at least two workloads each above ${t} W, with jointly feasible EV or home-battery charging moves to distinct strictly cheaper quarters; pool heating stays fixed`,
    fires: q => q.avoidableOverlap,
    eligibleFrom: () => 0,
  },
  {
    key: 'ev_from_home_battery', about: 'price', label: 'EV supplied by home battery',
    describe: t => `more than ${t} W of home-battery power supplies the EV after other loads and exports`,
    fires: (q, t) => q.evBatteryW > t,
    eligibleFrom: () => 0,
  },
  {
    key: 'pool_short_gap', about: 'price', label: 'Short interruption in pool heating',
    describe: t => `an avoidable 1–4-quarter gap; a gap quarter dearer than a bordering running quarter by more than the larger of ${Math.round(t * 100)} öre/kWh or ${SHORT_GAP_PRICE_FRACTION * 100}% of its absolute price excuses the pause only where the sun and spare battery could not have carried it`,
    fires: q => q.shortPoolGap, eligibleFrom: () => 0,
  },
  {
    key: 'early_grid_charge', about: 'price', label: 'Grid charge with a clearly cheaper quarter in reach',
    describe: t => `battery or car charging buys at least ${EARLY_CHARGE_GRID_W} W from the grid, and all of it has a feasible move to a later quarter cheaper by more than the larger of ${Math.round(t * 100)} öre/kWh or ${EARLY_CHARGE_PRICE_FRACTION * 100}% of this quarter's absolute price, without a higher bill`,
    fires: q => q.earlyGridCharge, eligibleFrom: () => 0,
  },
];

export const DEFAULT_RULES: QuarterRule[] = QUARTER_RULES.map(rule => ({...rule, ...ruleDefaults(rule.key)}));

/** The base-load price tiers share the same explanation and capability check. */
export const BASE_LOAD_DEAR_RULE_KEYS: readonly string[] = ['base_load_dear_import', 'base_load_dearest_import'];
/** The flexible-load price rules that count from the dear end of the plan's prices. */
export const DEAR_RULE_KEYS: readonly string[] = ['dear_load', 'dearest_load'];

/**
 * Rules of earlier scorers that judged money one quarter at a time. The
 * opportunity audit replaced them; an override stored under one of these names
 * is ignored by name, not applied to anything.
 */
export type ResolvedRule = QuarterRule & { enabled: boolean };

/** The bench's rules: the defaults with the saved `enabled`, `threshold` and `points` overrides applied. */
export function resolveRules(overrides: CriteriaOverrides = {}): ResolvedRule[] {
  const errors = criteriaErrors(overrides);
  if (errors.length) throw new CriteriaError(errors.join(' '));
  return DEFAULT_RULES.map(rule => {
    const o = overrides[rule.key] ?? {};
    return { ...rule, enabled: o.enabled ?? true, threshold: o.threshold ?? rule.threshold, points: o.points ?? rule.points };
  });
}

/** The comfort thresholds an alternative plan is held to: the bench's own, whether or not a rule is switched on. */
export function serviceGuard(overrides: CriteriaOverrides = {}): ServiceGuard {
  const t = Object.fromEntries(resolveRules(overrides).map(r => [r.key, r.threshold]));
  return { pool: [t.pool_low, t.pool_cold], ev: [t.ev_low, t.ev_short] };
}

export interface QuarterScore {
  /** What the quarter's deductions took, in points (kronor); never above 0 with the default rules. */
  score: number;
  /** Deduction rules that fired, in rule order. */
  fired: string[];
  /** Rules that were measured here and take no points: evidence rules, and a pool gap its restart is charged for. */
  noted: string[];
}

export interface ServiceApplicability {
  applicable: boolean;
  reason: string;
  /** Quarters in which the rule could fire. */
  eligibleQuarters: number;
}

export interface CaseScore {
  /** The case score: deductions less the net bill. While the bill or the audit is missing or pending, the deductions alone. */
  points: number;
  /** Whether `points` holds both parts. */
  complete: boolean;
  /** Null on a series from before the bill, awaiting recomputing. */
  bill: Bill | null;
  /** Null, explicitly, when the series carries none: a result from before the audit, awaiting rescoring. */
  audit: OpportunityAudit | null;
  /** The audit's witnesses do not hold under these thresholds, or it is of another version: recompute before reading it. */
  auditPending: boolean;
  /** The plan asked for what the household cannot do. */
  physicalFailed: boolean;
  /** Sum of every quarter's score: what the deductions took. */
  sum: number;
  quarters: QuarterScore[];
  thermalBuffer: BufferQuarter[] | null;
  /** How often each deduction was charged. */
  counts: Record<string, number>;
  /** How often each rule was measured without taking points. */
  noted: Record<string, number>;
  /** How many quarters scored each value. */
  histogram: Record<string, number>;
  requiredFired: string[];
  /** Per quarter rule: whether it could fire in this case at all, and in how many quarters. */
  applicability: Record<string, ServiceApplicability>;
  /** Your verdict when there is one, otherwise the automatic reading; never passed when physicalFailed. */
  passed: boolean;
  verdict: Verdict | null;
}

const sameGuard = (a: ServiceGuard, b: ServiceGuard) =>
  a.pool[0] === b.pool[0] && a.pool[1] === b.pool[1] && a.ev[0] === b.ev[0] && a.ev[1] === b.ev[1];

/** Whether every stored witness still holds under other comfort thresholds, from its stored traces. */
function witnessesHold(s: BenchSeries, audit: OpportunityAudit, guard: ServiceGuard): boolean {
  if (sameGuard(audit.guard, guard)) return true;
  if (audit.overlap.overlappingQuarters.length || audit.shortGaps.candidates.length || audit.earlyCharge.candidates.length) return false;
  const comfort = s.comfort;
  if (!comfort) return false;
  // A finding moves only its own device's store; the battery has no comfort level.
  return audit.findings.every(f =>
    f.device === 'pool' ? storeNotWorse(poolExposure(comfort, f.before.poolC, guard), poolExposure(comfort, f.after.poolC, guard))
      : f.device === 'ev' ? storeNotWorse(evExposure(comfort, f.before.carKm, guard), evExposure(comfort, f.after.carKm, guard))
        : true);
}

export function scoreQuarters(s: BenchSeries, overrides: CriteriaOverrides = {}, verdict: Verdict | null = null): CaseScore {
  return tally(s, overrides, verdict, false);
}

/**
 * What every enabled rule measured, each at its declared points, the evidence
 * rules included and no gap yielding to its restart: the lens the price rules
 * are read through. No score is made of it; `points` is the sum alone.
 */
export function measuredQuarters(s: BenchSeries, overrides: CriteriaOverrides = {}): CaseScore {
  const measured = tally(s, overrides, null, true);
  return { ...measured, points: measured.sum, complete: false };
}

function tally(s: BenchSeries, overrides: CriteriaOverrides, verdict: Verdict | null, measureAll: boolean): CaseScore {
  const resolved = resolveRules(overrides);
  const rules = resolved.filter(r => r.enabled);
  const n = s.start.length;
  const audit = s.audit ?? null;
  const overlapRule = resolved.find(r => r.key === 'large_load_overlap')!;
  const gapThresholds = Object.fromEntries(resolved.map(r => [r.key, r.threshold]));
  const preparation = arbitragePreparation(s, gapThresholds.arbitrage_not_full);
  const thermalBuffer = rules.some(r => r.key === 'pool_buffer')
    ? thermalBufferTrace(s, gapThresholds.pool_buffer, serviceGuard(overrides).pool[0], gapThresholds.pool_restart * 3600) : null;
  const bufferEvidenceMissing = rules.some(r => r.key === 'pool_buffer') && !!s.comfort && s.poolC.some(v => v !== null) && thermalBuffer === null;
  const batteryEvidenceMissing = s.baseLoadBatteryCoverW?.length !== n;
  const heaterEvidenceMissing = rules.some(r => r.key === 'pool_restart') && s.poolStart?.length !== n;
  const auditPending = bufferEvidenceMissing || heaterEvidenceMissing || batteryEvidenceMissing || !!audit && (audit.version !== OPPORTUNITY_AUDIT_VERSION
    || (audit.status === 'complete' && (!witnessesHold(s, audit, serviceGuard(overrides))
      || audit.overlap.thresholdW !== overlapRule.threshold
      || audit.shortGaps.priceTolerance.pool !== gapThresholds.pool_short_gap
      || audit.earlyCharge.priceTolerance !== gapThresholds.early_grid_charge)));
  const overlapQuarters = new Set(audit && !auditPending ? audit.overlap.moves.map(m => m.from) : []);
  const shortGaps = audit && !auditPending ? audit.shortGaps.gaps : [];
  // One pause, one deduction: where the restart rule charges a pool pause's restart, its gap is noted, not charged again.
  const restartRule = rules.find(r => r.key === 'pool_restart' && r.role === 'deduction');
  const yieldedPoolGap = new Set(shortGaps.filter(gap => {
    const start = gap.device === 'pool' ? s.poolStart?.[gap.to] : null;
    return !!restartRule && !!start && start.off_seconds !== null && start.off_seconds < restartRule.threshold * 3600;
  }).flatMap(gap => Array.from({ length: gap.to - gap.from }, (_, k) => gap.from + k)));
  const earlyCharges = new Set(audit && !auditPending ? audit.earlyCharge.moves.map(m => m.from) : []);
  // The first quarter from which each level counts, found once per level.
  const dueAt = new Map<string, number>();
  const due = (i: number): QuarterView['due'] => (reachable, start, level) => {
    const id = `${reachable === s.comfort?.poolReachableC ? 'pool' : 'car'}:${level}`;
    if (!dueAt.has(id)) dueAt.set(id, dueFrom(reachable, start, level));
    return i >= dueAt.get(id)!;
  };

  const sorted = [...s.importPrice].sort((a, b) => a - b);
  /** How many of the plan's prices are below this one; with `orEqual`, at or below it. */
  const below = (price: number, orEqual = false) => {
    let lo = 0, hi = sorted.length;
    while (lo < hi) { const mid = (lo + hi) >> 1; if (sorted[mid] < price || (orEqual && sorted[mid] === price)) lo = mid + 1; else hi = mid; }
    return lo;
  };

  const priceRank = s.importPrice.map(price => n ? below(price) / n : 0);
  const cheapRule = rules.find(r => r.key === 'cheap_buy');
  const cheapValley = cheapRule ? stretchedValleys(priceRank, cheapRule.threshold) : [];

  // Each plan day's mean price and solar, to judge warmth held for the day after.
  const days = Array.from({ length: Math.ceil(n / DAY_QUARTERS) }, (_, d) => {
    const of = (values: number[]) => values.slice(d * DAY_QUARTERS, (d + 1) * DAY_QUARTERS);
    const mean = (values: number[]) => values.reduce((a, b) => a + b, 0) / Math.max(1, values.length);
    return { price: mean(of(s.importPrice)), solar: mean(of(s.solarW)), full: of(s.importPrice).length === DAY_QUARTERS };
  });
  const aheadOf = (i: number): QuarterView['ahead'] => {
    const today = days[Math.floor(i / DAY_QUARTERS)], next = days[Math.floor(i / DAY_QUARTERS) + 1];
    return next?.full ? { dearer: next.price > today.price * (1 + AHEAD_MARGIN), lessSun: next.solar < today.solar * (1 - AHEAD_MARGIN) } : null;
  };

  const counts: Record<string, number> = {};
  const noted: Record<string, number> = {};
  const histogram: Record<string, number> = {};
  const quarters: QuarterScore[] = [];
  let sum = 0;
  const hot = rules.find(r => r.key === 'pool_hot');
  for (let i = 0; i < n; i++) {
    const baseGridW = baseLoadGridSupplyW(s, i);
    const before = poolBeforeC(s, i);
    const rewardingFlexibleW = s.batteryChargeW[i] + s.carW[i]
      + (hot && before !== null && s.comfort && before >= s.comfort.pool_target_c + hot.threshold ? 0 : s.poolW[i]);
    const q: QuarterView = {
      s, i, due: due(i), thermalBuffer: thermalBuffer?.[i].earns ?? false, ahead: aheadOf(i), priceRank: priceRank[i], cheapValley: cheapValley[i] ?? false,
      dearRank: n ? (n - below(s.importPrice[i], true)) / n : 0,
      rewardingFlexibleW, flexibleGridW: flexibleGridSupplyW(s, i),
      baseLoadCoverable: !batteryEvidenceMissing && baseGridW >= FLEXIBLE_W
        && s.baseLoadBatteryCoverW[i] >= baseGridW,
      avoidableOverlap: overlapQuarters.has(i),
      shortPoolGap: shortGaps.some(gap => gap.device === 'pool' && gap.from <= i && i < gap.to),
      earlyGridCharge: earlyCharges.has(i),
      evBatteryW: evBatterySupplyW(s, i),
      arbitragePrepared: preparation.prepared,
    };
    const firing = rules.filter(rule => rule.fires(q, rule.threshold));
    let score = 0;
    const fired: string[] = [], seen: string[] = [];
    for (const rule of firing) {
      if (rule.unless && firing.some(other => other.key === rule.unless)) continue;
      if (!measureAll && (rule.role === 'evidence' || rule.key === 'pool_short_gap' && yieldedPoolGap.has(i))) {
        seen.push(rule.key);
        noted[rule.key] = (noted[rule.key] ?? 0) + 1;
        continue;
      }
      score += rule.points;
      fired.push(rule.key);
      counts[rule.key] = (counts[rule.key] ?? 0) + 1;
    }
    histogram[String(score)] = (histogram[String(score)] ?? 0) + 1;
    sum += score;
    quarters.push({ score, fired, noted: seen });
  }
  const requiredFired = rules.filter(r => r.required && counts[r.key]).map(r => r.key);

  const applicability: Record<string, ServiceApplicability> = Object.fromEntries(resolved.map(rule => {
    const eligibleQuarters = Math.max(0, n - Math.min(n, rule.eligibleFrom(s, rule.threshold)));
    const reason = rule.key === 'pool_buffer' && bufferEvidenceMissing ? 'Thermal model, weather, calendar and heater transitions need recomputing.'
      : rule.key === 'pool_restart' && s.poolStart?.length !== n ? 'Heater command transitions need recomputing.'
      : !rule.enabled ? 'Switched off for this case.'
      : rule.key !== 'pool_restart' && rule.about !== 'price' && !s.comfort ? 'The plan carries no targets.'
        : !eligibleQuarters ? 'This level was not reachable for a day within the window.'
          : `Counts in ${eligibleQuarters} of ${n} quarters.`;
    return [rule.key, { applicable: rule.enabled && eligibleQuarters > 0, reason, eligibleQuarters }];
  }));

  const physicalFailed = !!audit && audit.violations.length > 0;
  const bill = s.bill ?? null;
  const complete = !!audit && !auditPending && !!bill;
  const points = complete ? Math.round((sum - bill.net_sek) * 10_000) / 10_000 : sum;
  return {
    points, complete, bill, audit, auditPending, physicalFailed,
    sum, quarters, thermalBuffer, counts, noted, histogram, requiredFired, applicability, verdict,
    passed: !physicalFailed && (verdict ? verdict === 'pass' : requiredFired.length === 0),
  };
}

/** What the bench stores per result, so run lists need no plan series. */
export interface StoredScore {
  version: number;
  /** Fingerprint of the rule overrides the score was computed with. */
  criteria: string;
  /** The case score, a point a krona: sum − (grid_sek + wear_sek − credit_sek). */
  points: number;
  /** What the deductions took, with its histogram and counts. */
  sum: number;
  /** The bill the score is made of (referee.ts billOf). */
  grid_sek: number;
  wear_sek: number;
  credit_sek: number;
  histogram: Record<string, number>;
  counts: Record<string, number>;
  /** How often each rule was measured without taking points. */
  noted: Record<string, number>;
  required_fired: string[];
  /** The plan asked for what the household cannot do: the case fails whatever its points. */
  physical_failed: boolean;
  audit: OpportunityAuditSummary;
}

/** Stable over key order; overrides of removed rules do not count. */
export const criteriaFingerprint = (overrides: CriteriaOverrides = {}) =>
  JSON.stringify(Object.keys(overrides).filter(k => !REMOVED_RULE_KEYS.includes(k)).sort().map(k => [k, overrides[k]]));

/** The effective rule inputs, including defaults, used by the rule-driven solver: the deduction rules, which are all it is sent. */
export const plannerInputsFingerprint = (rules: readonly {
  key: string; threshold: number; points: number; required?: boolean; unless?: string | null;
}[], guard: ServiceGuard) => JSON.stringify({
  rules: rules.map(r => ({ key: r.key, threshold: r.threshold, points: r.points,
    required: r.required ?? false, unless: r.unless ?? null })), service_guard: guard,
});
export const plannerRulesFingerprint = (overrides: CriteriaOverrides = {}) =>
  plannerInputsFingerprint(resolveRules(overrides).filter(r => r.enabled && r.role === 'deduction'), serviceGuard(overrides));

/** Full supplied inputs: historical planners may consume rules today's scorer removed. */
export const plannerCriteriaFingerprint = (overrides: CriteriaOverrides = {}) => canonicalJson(overrides);

/** Immutable planner defaults may differ; freshness concerns the supplied overrides. */
export function plannerRuleInputsCurrent(result: {
  planner_generation?: string | null; planner_rules?: string | null; planner_criteria?: string | null;
}, overrides: CriteriaOverrides): boolean {
  return !result.planner_generation?.startsWith('ready-wasm-')
    || Boolean(result.planner_rules) && result.planner_criteria === plannerCriteriaFingerprint(overrides);
}

export function storedScore(s: BenchSeries, overrides: CriteriaOverrides = {}): StoredScore {
  const c = scoreQuarters(s, overrides);
  if (!c.audit || c.auditPending) {
    throw new Error(c.audit
      ? 'The plan\'s opportunity audit needs recomputing for these rule thresholds or this audit version; evaluate the plan again (evaluate.ts).'
      : 'A score needs the plan\'s opportunity audit; evaluate the plan (evaluate.ts) rather than scoring a bare series.');
  }
  if (!c.bill) throw new Error('A score needs the plan\'s bill; evaluate the plan (evaluate.ts) rather than scoring a series from before it.');
  return {
    version: SCORER_VERSION, criteria: criteriaFingerprint(overrides),
    points: c.points, sum: c.sum, grid_sek: c.bill.grid_sek, wear_sek: c.bill.wear_sek, credit_sek: c.bill.credit.credit_sek,
    histogram: c.histogram, counts: c.counts, noted: c.noted, required_fired: c.requiredFired,
    physical_failed: c.physicalFailed, audit: summariseAudit(c.audit),
  };
}

export const isStale = (score: StoredScore | null | undefined, overrides: CriteriaOverrides = {}) =>
  !score || score.version !== SCORER_VERSION || score.audit?.version !== OPPORTUNITY_AUDIT_VERSION
  || score.criteria !== criteriaFingerprint(overrides);

/** Pass/fail from a stored score and your verdict. A plan the household cannot carry out never passes. */
export const storedPassed = (score: StoredScore, verdict: Verdict | null) =>
  !score.physical_failed && (verdict ? verdict === 'pass' : score.required_fired.length === 0);

/** Sum of the displayed case points; null until at least one case has a result. */
export function runScore(casePoints: readonly number[]): number | null {
  if (!casePoints.length) return null;
  return Math.round(casePoints.reduce((a, b) => a + b, 0) * 10_000) / 10_000;
}

/**
 * The versions worth listing, oldest first. Where consecutive versions scored the same, the changes between them
 * did not move the planner, so only the newest of them stays. A version without a score is never dropped and never
 * counts as the same as its neighbour; neither is one `keep` names.
 */
export function distinctScoreRuns<T>(runs: readonly T[], scoreOf: (run: T) => number | null, keep: (run: T) => boolean = () => false): T[] {
  return runs.filter((run, i) => {
    if (i === runs.length - 1 || keep(run)) return true;
    // Scores are kronor: two that agree to the öre are the same.
    const score = scoreOf(run), next = scoreOf(runs[i + 1]);
    return score === null || next === null || Math.round(score * 100) !== Math.round(next * 100);
  });
}
