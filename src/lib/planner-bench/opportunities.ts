// What a plan left on the table: money it could have saved by moving energy
// in time, with the same comfort and the same stores at the end.
//
// A single quarter cannot say whether an export or an import was a mistake;
// that depends on what the stores did over the days around it. So nothing here
// judges a quarter. A finding is a proven transfer: a small edit to the plan's
// own decisions (charge here, discharge there; heat the pool in that hour
// instead of this one), replayed through the referee's physics, that
//
//   - asks nothing the household cannot do,
//   - leaves each store no more short of its target than before, pool and car
//     each on its own,
//   - ends with the battery, the pool and the car where the plan ended them,
//   - and costs less at real prices, after the change in battery cycling wear.
//
// Accepted transfers are applied one on top of the other, so their savings add
// up to exactly the difference between the plan and the improved plan. A
// finding carries one rule and may carry several tags; the money belongs to the
// finding, never to each tag.
//
// The search is bounded and greedy. What it finds is a lower bound on what was
// avoidable; finding nothing means "no loss found", not "optimal". A finding
// is `known` only when every quarter it changes had a published price in the
// plan's lane; the rest is `hindsight` and is reported, not scored. The known
// search runs to its end before the hindsight one starts, so hindsight can
// never use up a saving the planner could have seen.
//
// Limits, by design:
//   - The end state is held fixed, so heat or charge that is simply wasted at
//     the end of the window is not reported.
//   - Edits move whole hours (pool: whole heater quarters), so a saving inside
//     an hour can be missed.
//   - What the bench does not model cannot be judged: NOT_MODELLED.
//
// Bump OPPORTUNITY_AUDIT_VERSION (and SCORER_VERSION, score.ts) when the
// search or its guards change.

import { QUARTERS, publishedQuarters, type BenchCase, type Targets } from './case';
import { thermalTimeConstantH } from '../../../supabase/functions/_shared/planner/device-models';
import type { Household } from './household';
import { laneParts, type LaneId } from './lanes';
import { assertDecisions, evLevels, evLimitKwh, evMaxW, HOURS, householdSeries, poolLevels, reachability, simulate, type Decisions, type Simulation, type Violation } from './referee';
import { stepMove } from './step-moves';
import { auditLargeLoadOverlap, LARGE_WORKLOAD_W, type LargeLoadOverlapAudit } from './large-load-overlap';
import { auditShortGaps, SHORT_GAP_PRICE_TOLERANCE, type GapDevice, type ShortGapAudit } from './short-gaps';
import { DEFAULT_SERVICE_GUARD, serviceExposure, serviceNotWorse, type Comfort, type ServiceExposure, type ServiceGuard } from './service';

export const OPPORTUNITY_AUDIT_VERSION = 8;

/** Quarters edited together: one hour. */
const BLOCK = 4;
const BLOCKS = QUARTERS / BLOCK;
const DAY_BLOCKS = 96 / BLOCK;
/** W over one quarter, as kWh. */
const KWH = HOURS / 1_000;
/** Replays allowed per audit, the plan's own included. */
export const MAX_TRIALS = 2_500;
/** Accepted transfers per basis. */
const MAX_TRANSFERS = 120;
/** Findings opened per basis, each stored with its before and after trace; later transfers join them. */
const MAX_FINDINGS = 10;
/** A transfer worth less than this is noise. */
const MIN_SAVING_SEK = 0.05;
const MIN_KWH = 0.05;
/** Battery and car must end where the plan ended them, to rounding. */
const END_TOLERANCE_KWH = 1e-6;
const SCALES = [1, 0.5, 0.25];
/** Power below this is not a surplus or an import worth naming. */
const NOTABLE_W = 100;

export type OpportunityRuleKey =
  | 'export_before_import' | 'import_avoidable_by_storage' | 'battery_price_spread' | 'battery_preserve'
  | 'battery_headroom_solar' | 'high_value_export' | 'uneconomic_cycling'
  | 'pool_solar_preheat' | 'pool_wait_for_sun' | 'pool_cheaper_heating' | 'ev_timing';
export type OpportunityDevice = 'battery' | 'pool' | 'ev';

export interface OpportunityRuleMeta {
  key: OpportunityRuleKey;
  label: string;
  description: string;
  device: OpportunityDevice;
  category: 'solar' | 'price' | 'waste';
}

/** The catalogue, in display order. Results per rule are in `audit.rules` and `audit.applicability`. */
export const OPPORTUNITY_RULES: OpportunityRuleMeta[] = [
  { key: 'export_before_import', device: 'battery', category: 'solar', label: 'Solar exported, then bought back',
    description: 'Surplus solar was sold cheaply while the battery had room, and the home imported at a higher price later.' },
  { key: 'battery_headroom_solar', device: 'battery', category: 'solar', label: 'No room in the battery for the sun',
    description: 'The battery was full, or filled from the grid, when surplus solar arrived; using it earlier would have left room.' },
  { key: 'pool_solar_preheat', device: 'pool', category: 'solar', label: 'Pool not preheated on surplus solar',
    description: 'Moving later heat into earlier surplus solar saves money after heat loss, above target if useful.' },
  { key: 'pool_wait_for_sun', device: 'pool', category: 'solar', label: 'Pool heated before the sun',
    description: 'Moving earlier heat into later surplus solar saves money without worsening comfort.' },
  { key: 'import_avoidable_by_storage', device: 'battery', category: 'price', label: 'Dear import the battery could have covered',
    description: 'The home imported at a high price that energy stored earlier, or held back, would have covered.' },
  { key: 'battery_price_spread', device: 'battery', category: 'price', label: 'Price spread not used',
    description: 'Charging from the grid when cheap and discharging when dear would have paid for its losses and wear.' },
  { key: 'battery_preserve', device: 'battery', category: 'price', label: 'Battery emptied before the dearer hours',
    description: 'The battery was discharged against a price lower than one it could have met later.' },
  { key: 'high_value_export', device: 'battery', category: 'price', label: 'High export price missed',
    description: 'Stored energy could have been exported at a price above what it cost to store or replace.' },
  { key: 'pool_cheaper_heating', device: 'pool', category: 'price', label: 'Pool heated at a dear time',
    description: 'The same pool heat was available in a cheaper or more efficient hour.' },
  { key: 'ev_timing', device: 'ev', category: 'price', label: 'Car charged at a dear time',
    description: 'The same charge was available in a cheaper hour or from surplus solar.' },
  { key: 'uneconomic_cycling', device: 'battery', category: 'waste', label: 'Battery cycling that lost money',
    description: 'A charge and a discharge that cost more in losses and wear than the price difference returned.' },
];

/** What the bench does not model, so no rule can judge it. */
export const NOT_MODELLED: { key: string; label: string }[] = [
  { key: 'ev_presence', label: 'When the car is away, plugged in or needed' },
  { key: 'rooms_hot_water', label: 'Room heating and hot water (fixed demand)' },
  { key: 'forecast_error', label: 'Solar, load and weather forecast error' },
  { key: 'sub_quarter', label: 'Clouds and load changes within a quarter' },
  { key: 'tariff_peak', label: 'Peak-power tariffs' },
  { key: 'overrides', label: 'Owner overrides and the devices\' own controllers' },
  { key: 'heater_run', label: 'Native heater protection and equipment start costs' },
  { key: 'end_waste', label: 'Energy wasted at the very end of the window' },
];

/**
 * A store at the end of every quarter. A finding changes only its own device's
 * store, so only that array is filled: `homeSoc` (%) for the battery, `poolC`
 * for the pool, `carKm` for the car. The other two are empty.
 */
export interface OpportunityTrace { poolC: number[]; carKm: number[]; homeSoc: number[] }

export interface OpportunityFinding {
  /** `k1`, `k2`, … known; `h1`, … hindsight; in the order they were accepted. */
  id: string;
  /** The label the saving is counted under. */
  rule: OpportunityRuleKey;
  /** Every label that explains it, `rule` first. One saving, however many tags. */
  tags: OpportunityRuleKey[];
  device: OpportunityDevice;
  /** Quarters energy was taken from, inclusive. */
  from: number; fromEnd: number;
  /** Quarters it was put in, inclusive. */
  to: number; toEnd: number;
  /** Energy moved, kWh on the AC side. */
  kwh: number;
  /** Grid saving at real prices, less battery wear. */
  savingSek: number;
  gridSavingSek: number;
  wearSek: number;
  basis: 'known' | 'hindsight';
  /** Accepted transfers merged into this finding. */
  transfers: number;
  /** The device's store before and after this finding, its earlier findings already applied. */
  before: OpportunityTrace;
  after: OpportunityTrace;
}

/**
 * One rule's share of the audit, counted transfer by transfer: energy moved and
 * money, each transfer under exactly one rule. `findings` is how many findings
 * carry the rule as their own.
 */
export interface OpportunityRuleResult {
  findings: number;
  kwh: number;
  knownSek: number;
  hindsightSek: number;
  /** Unique quarters changed by accepted transfers under this primary rule while prices were published. */
  knownQuarters: number[];
}

interface AuditCore {
  version: number;
  lane: LaneId;
  /** `invalid`: the plan asked for what the household cannot do, so nothing was compared. */
  status: 'complete' | 'invalid';
  reason: string | null;
  /** The comfort thresholds every alternative was held to. */
  guard: ServiceGuard;
  /** Independent feasible cheaper-quarter witnesses; their source quarters score once each. */
  overlap: LargeLoadOverlapAudit;
  /** Independent feasible alternatives joining short interruptions at similar prices. */
  shortGaps: ShortGapAudit;
  /** The household's cash exposure with no store acting, at absolute prices; at least 1. */
  scaleSek: number;
  originalCostSek: number;
  improvedCostSek: number;
  /** knownSek + hindsightSek. */
  avoidableSek: number;
  knownSek: number;
  hindsightSek: number;
  /** Signed change in battery discharge wear; negative means wear avoided. Already subtracted from savings. */
  wearSek: number;
  trials: number;
  /** The search stopped on its budget with candidates left. */
  limitReached: boolean;
  rules: Record<OpportunityRuleKey, OpportunityRuleResult>;
  applicability: Record<OpportunityRuleKey, { applicable: boolean; reason: string }>;
}

export interface OpportunityAudit extends AuditCore {
  findings: OpportunityFinding[];
  violations: Violation[];
}

/** What a stored score keeps of an audit: no traces, no finding list. */
export interface OpportunityAuditSummary extends AuditCore {
  findingCount: number;
  violations: number;
  violationKinds: Record<string, number>;
}

export function summariseAudit(audit: OpportunityAudit): OpportunityAuditSummary {
  const { findings, violations, ...core } = audit;
  const violationKinds: Record<string, number> = {};
  for (const v of violations) violationKinds[v.kind] = (violationKinds[v.kind] ?? 0) + 1;
  return { ...core, findingCount: findings.length, violations: violations.length, violationKinds };
}

export type RuleState = 'not_applicable' | 'unverified' | 'no_loss_found' | 'loss_found';

/** How a rule reads for one audit. `no_loss_found` is what the bounded search found, not a proof. */
export function ruleState(audit: Pick<AuditCore, 'status' | 'rules' | 'applicability'>, key: OpportunityRuleKey): RuleState {
  if (audit.status !== 'complete') return 'unverified';
  if (audit.rules[key].findings > 0) return 'loss_found';
  return audit.applicability[key].applicable ? 'no_loss_found' : 'not_applicable';
}

const r1 = (v: number) => Math.round(v * 10) / 10;
const r3 = (v: number) => Math.round(v * 1_000) / 1_000;
const r4 = (v: number) => Math.round(v * 10_000) / 10_000;
const dayOf = (block: number) => Math.min(2, Math.floor(block / DAY_BLOCKS));

// ---------------------------------------------------------------------------
// Applicability: from the case alone, never from what a planner did.

function applicabilityOf(c: BenchCase, h: Household, _targets: Targets): AuditCore['applicability'] {
  // Conservative eligibility, not a profitability test. Flexible demand, COP,
  // starting inventory and intervening actions all affect the actual opportunity.
  // In particular, flat prices do not make moving pool heat ineligible.
  const world = householdSeries(c);
  const surplus = world.baseW.map((load, i) => world.solarW[i] - load > NOTABLE_W);
  const anySurplus = surplus.some(Boolean);
  const battery = h.battery.capacity_kwh > 0 && h.battery.charge_max_w > 0 && h.battery.discharge_max_w > 0;
  const pool = poolLevels(h).at(-1)!.heat_w > 0;
  const car = h.car.battery.capacity_kwh > 0 && evMaxW(h) > 0 && c.start_state.ev.soc < c.start_state.ev.target_soc;
  const when = (applicable: boolean, yes: string, no: string) => ({ applicable, reason: applicable ? yes : no });
  const batteryRule = () => when(battery, 'The battery can store and release energy; the replay tests whether changing its timing saves money.', 'No usable battery in this case.');
  const solarBattery = () => when(battery && anySurplus, 'Surplus solar and a battery are present; the replay tests their timing together.', !anySurplus ? 'No surplus solar in this case.' : 'No usable battery in this case.');
  return {
    export_before_import: solarBattery(),
    battery_headroom_solar: solarBattery(),
    pool_solar_preheat: when(pool && surplus.slice(0, -1).some(Boolean), 'Solar can supply earlier heat; the replay checks retained heat and later service.', !pool ? 'No pool heater in this case.' : 'No earlier surplus solar in this case.'),
    pool_wait_for_sun: when(pool && surplus.slice(1).some(Boolean), 'Solar can supply later heat; the replay checks service while the pool coasts.', !pool ? 'No pool heater in this case.' : 'No later surplus solar in this case.'),
    import_avoidable_by_storage: batteryRule(),
    battery_price_spread: batteryRule(),
    battery_preserve: batteryRule(),
    high_value_export: batteryRule(),
    pool_cheaper_heating: when(pool, 'Pool heat can move between hours; prices and heat loss determine whether it helps.', 'No pool heater in this case.'),
    ev_timing: when(car, 'The car is always available to charge and starts below its charge limit.', 'The car has no charging capacity or starts at its charge limit.'),
    uneconomic_cycling: batteryRule(),
  };
}

// ---------------------------------------------------------------------------
// The search.

/** One side of a transfer: a change of grid power over one hour. */
interface Offer {
  block: number;
  /** W per quarter of the block, as a magnitude. */
  w: number[];
  kwh: number;
  /** Change in grid cost if taken in full, SEK. */
  dSek: number;
  hindsight: boolean;
  /** Share of it drawn from power that was being exported (more load), or that replaces import (less load). */
  share: number;
  /** 0 keeps each quarter on one side of the meter; 1 takes all the device allows. */
  variant: number;
}

type BatterySide = 'chargeAdd' | 'chargeCut' | 'dischargeAdd' | 'dischargeCut';
type TransferKind = 'cycle_add' | 'cycle_cut' | 'charge_move' | 'discharge_move' | 'ev_move' | 'pool_move';
const BATTERY_KINDS: { kind: TransferKind; up: BatterySide; down: BatterySide }[] = [
  { kind: 'cycle_add', up: 'chargeAdd', down: 'dischargeAdd' },
  { kind: 'cycle_cut', up: 'dischargeCut', down: 'chargeCut' },
  { kind: 'charge_move', up: 'chargeAdd', down: 'chargeCut' },
  { kind: 'discharge_move', up: 'dischargeCut', down: 'dischargeAdd' },
];
const KIND_ORDER: TransferKind[] = ['cycle_add', 'cycle_cut', 'charge_move', 'discharge_move', 'ev_move', 'pool_move'];

interface Candidate {
  kind: TransferKind;
  /** Battery: the side that adds stored energy. Car and pool: where energy is taken from. */
  a: Offer;
  /** Battery: the side that removes stored energy. Car and pool: where it is put. */
  b: Offer;
  /** Share of each offer used. */
  fa: number; fb: number;
  est: number;
  key: string;
}

interface Plan { d: Decisions; sim: Simulation; exposure: ServiceExposure; dischargedKwh: number }

interface Transfer {
  rule: OpportunityRuleKey; tags: OpportunityRuleKey[]; device: OpportunityDevice;
  from: number; fromEnd: number; to: number; toEnd: number;
  kwh: number; grid: number; wear: number; basis: 'known' | 'hindsight';
  before: Simulation; after: Simulation;
}

/** Minimum of a per-block value over every run of blocks, flat [u * BLOCKS + v] for u <= v. */
function rangeMin(perQuarter: (q: number) => number): Float64Array {
  const block = new Float64Array(BLOCKS);
  for (let b = 0; b < BLOCKS; b++) {
    let low = Infinity;
    for (let k = 0; k < BLOCK; k++) low = Math.min(low, perQuarter(b * BLOCK + k));
    block[b] = low;
  }
  const out = new Float64Array(BLOCKS * BLOCKS);
  for (let u = 0; u < BLOCKS; u++) {
    let low = Infinity;
    for (let v = u; v < BLOCKS; v++) { low = Math.min(low, block[v]); out[u * BLOCKS + v] = low; }
  }
  return out;
}

export function auditOpportunities(
  c: BenchCase, h: Household, targets: Targets, decisions: Decisions, lane: LaneId, guard: ServiceGuard = DEFAULT_SERVICE_GUARD,
  largeWorkloadW = LARGE_WORKLOAD_W,
  gapPriceTolerance: Record<GapDevice, number> = { pool: SHORT_GAP_PRICE_TOLERANCE, ev: SHORT_GAP_PRICE_TOLERANCE },
): OpportunityAudit {
  return findOpportunities(c, h, targets, decisions, lane, guard, largeWorkloadW, gapPriceTolerance).audit;
}

/** The audit together with the improved plan its findings add up to, so one can be checked against the other. */
export function findOpportunities(
  c: BenchCase, h: Household, targets: Targets, decisions: Decisions, lane: LaneId, guard: ServiceGuard = DEFAULT_SERVICE_GUARD,
  largeWorkloadW = LARGE_WORKLOAD_W,
  gapPriceTolerance: Record<GapDevice, number> = { pool: SHORT_GAP_PRICE_TOLERANCE, ev: SHORT_GAP_PRICE_TOLERANCE },
): { audit: OpportunityAudit; improved: Decisions } {
  assertDecisions(decisions);
  const buy = c.recorded.prices.import_sek_per_kwh, sell = c.recorded.prices.export_sek_per_kwh;
  const air = c.recorded.outdoor_temperature_c;
  const last = QUARTERS - 1;
  const published = laneParts(lane).prices === 'oracle' ? QUARTERS : publishedQuarters(c);
  const wearRate = h.site.battery_degradation_sek_per_kwh;
  const etaC = h.battery.charge_efficiency, etaD = h.battery.discharge_efficiency;
  const batteryMinKwh = h.battery.min_soc * h.battery.capacity_kwh, batteryMaxKwh = h.battery.max_soc * h.battery.capacity_kwh;
  const carLevels = evLevels(h), carMaxW = evMaxW(h), carLimitKwh = evLimitKwh(c, h);
  // The heat pump is on at its setting or off, so pool heat moves in whole quarters of it.
  const poolOn = poolLevels(h).at(-1)!;
  /** Heat one running quarter puts into the pool, and what that warms it by. */
  const quarterHeatKwh = poolOn.heat_w * KWH, quarterC = quarterHeatKwh / h.pool.store.capacity_kwh_per_c;
  /** Hours for the pool to lose 63 % of a surplus of warmth. */
  const poolTauH = thermalTimeConstantH(h.pool.store, targets.pool_c, air.reduce((a, b) => a + b, 0) / QUARTERS);
  /** The pool may end up to one running quarter warmer than the plan, never colder: it cannot be heated by less. */
  const POOL_END_TOLERANCE_C = quarterC;

  const world = householdSeries(c);
  const scaleSek = Math.max(1, world.baseW.reduce((sum, load, i) => {
    const net = load - world.solarW[i];
    return sum + Math.abs(net) * Math.abs(net > 0 ? buy[i] : sell[i]) * KWH;
  }, 0));
  const emptyRules = () => Object.fromEntries(OPPORTUNITY_RULES.map(r => [r.key, { findings: 0, kwh: 0, knownSek: 0, hindsightSek: 0, knownQuarters: [] }])) as AuditCore['rules'];
  const applicability = applicabilityOf(c, h, targets);

  let trials = 1;
  const original = simulate(c, h, decisions);
  const core = {
    version: OPPORTUNITY_AUDIT_VERSION, lane, guard: { pool: [...guard.pool], ev: [...guard.ev] } as ServiceGuard,
    overlap: { thresholdW: largeWorkloadW, overlappingQuarters: [], moves: [] } as LargeLoadOverlapAudit,
    shortGaps: { priceTolerance: { ...gapPriceTolerance }, candidates: [], gaps: [] } as ShortGapAudit,
    scaleSek: r4(scaleSek), originalCostSek: r4(original.cost), applicability,
  };
  // Asked of the household as the planner was told it; a measured day differing from its forecast is not a violation.
  const violations = c.recorded.actual ? simulate(c, h, decisions, 'told').violations : original.violations;
  if (violations.length) {
    const kinds = [...new Set(violations.map(v => v.kind))].join(', ');
    return { improved: decisions, audit: {
      ...core, status: 'invalid',
      reason: `The plan asks for what the household cannot do (${kinds}, ${violations.length} in all), so no alternative can be compared with it.`,
      improvedCostSek: r4(original.cost), avoidableSek: 0, knownSek: 0, hindsightSek: 0, wearSek: 0,
      trials, limitReached: false, rules: emptyRules(), findings: [], violations,
    } };
  }

  core.overlap = auditLargeLoadOverlap(c, h, targets, decisions, original, guard, largeWorkloadW);
  core.shortGaps = auditShortGaps(c, h, targets, decisions, original, guard, gapPriceTolerance);

  const reach = reachability(c, h);
  const comfort: Comfort = {
    pool_target_c: targets.pool_c, ev_target_km: targets.ev_km,
    pool_start_c: original.start.poolC, ev_start_km: original.start.evKwh / h.car.battery.kwh_per_km,
    poolReachableC: reach.poolC, carReachableKm: reach.carKm,
  };
  const carKmOf = (sim: Simulation) => Array.from(sim.evKwh, v => v / h.car.battery.kwh_per_km);
  const exposureOf = (sim: Simulation) => serviceExposure(comfort, sim.poolC, carKmOf(sim), guard);
  const dischargedOf = (sim: Simulation) => sim.dischargeW.reduce((sum, w) => sum + w * KWH, 0);
  const planOf = (d: Decisions, sim: Simulation): Plan => ({ d, sim, exposure: exposureOf(sim), dischargedKwh: dischargedOf(sim) });

  let plan = planOf({
    pool_w: [...decisions.pool_w], ev_w: [...decisions.ev_w],
    battery_charge_w: [...decisions.battery_charge_w], battery_discharge_w: [...decisions.battery_discharge_w],
  }, original);

  const gridCost = (i: number, net: number) => (net > 0 ? net * buy[i] : net * sell[i]) * KWH;

  /** Up to two offers per hour: one that keeps each quarter on its side of the meter, one that takes all the device allows. */
  const offersOf = (cap: (q: number) => number, sign: 1 | -1): Offer[][] => {
    const net = plan.sim.netW;
    return Array.from({ length: BLOCKS }, (_, block) => {
      const make = (variant: number): Offer | null => {
        const w: number[] = [];
        let kwh = 0, dSek = 0, hindsight = false, shared = 0;
        for (let k = 0; k < BLOCK; k++) {
          const q = block * BLOCK + k;
          const side = Math.max(0, -sign * net[q]);
          let room = Math.max(0, cap(q));
          if (variant === 0 && side > 0) room = Math.min(room, side);
          w.push(room);
          if (room <= 0) continue;
          kwh += room * KWH;
          shared += Math.min(room, side) * KWH;
          dSek += gridCost(q, net[q] + sign * room) - gridCost(q, net[q]);
          if (q >= published) hindsight = true;
        }
        return kwh < MIN_KWH ? null : { block, w, kwh, dSek, hindsight, share: shared / kwh, variant };
      };
      const narrow = make(0), wide = make(1);
      return [narrow, wide && (!narrow || wide.kwh > narrow.kwh + 1e-9) ? wide : null].filter((o): o is Offer => o !== null);
    });
  };

  /** The best candidate of each kind between each pair of days, by estimate, best first. */
  const candidatesOf = (basis: 'known' | 'hindsight', rejected: Set<string>): Candidate[] => {
    const { sim, d } = plan;
    const buckets = new Map<number, Candidate>();
    const offer = (kind: TransferKind, a: Offer, b: Offer, fa: number, fb: number, est: number) => {
      if (!(est >= MIN_SAVING_SEK) || (a.hindsight || b.hindsight) !== (basis === 'hindsight')) return;
      const bucket = KIND_ORDER.indexOf(kind) * 9 + dayOf(a.block) * 3 + dayOf(b.block);
      const best = buckets.get(bucket);
      if (best && best.est >= est) return;
      const key = `${kind}:${a.block}.${a.variant}:${b.block}.${b.variant}`;
      if (!rejected.has(key)) buckets.set(bucket, { kind, a, b, fa, fb, est, key });
    };

    // Battery: one side stores more, the other less, the same energy on both.
    const room = rangeMin(q => batteryMaxKwh - sim.batteryKwh[q]);
    const stored = rangeMin(q => sim.batteryKwh[q] - batteryMinKwh);
    const side: Record<BatterySide, { offers: Offer[][]; perKwh: number }> = {
      chargeAdd: { offers: offersOf(q => h.battery.charge_max_w - d.battery_charge_w[q], 1), perKwh: etaC },
      dischargeCut: { offers: offersOf(q => d.battery_discharge_w[q], 1), perKwh: 1 / etaD },
      dischargeAdd: { offers: offersOf(q => h.battery.discharge_max_w - d.battery_discharge_w[q], -1), perKwh: 1 / etaD },
      chargeCut: { offers: offersOf(q => d.battery_charge_w[q], -1), perKwh: etaC },
    };
    for (const { kind, up, down } of BATTERY_KINDS) {
      for (let u = 0; u < BLOCKS; u++) {
        if (!side[up].offers[u].length) continue;
        for (let v = 0; v < BLOCKS; v++) {
          if (!side[down].offers[v].length || (u === v && kind !== 'cycle_cut')) continue;
          // Between the two the battery holds more (stored first) or less (released first).
          const limit = u === v ? Infinity : u < v ? room[u * BLOCKS + v - 1] : stored[v * BLOCKS + u - 1];
          for (const a of side[up].offers[u]) for (const b of side[down].offers[v]) {
            const kwh = Math.min(a.kwh * side[up].perKwh, b.kwh * side[down].perKwh, limit);
            if (kwh < MIN_KWH) continue;
            const fa = kwh / (a.kwh * side[up].perKwh), fb = kwh / (b.kwh * side[down].perKwh);
            const discharged = (down === 'dischargeAdd' ? b.kwh * fb : 0) - (up === 'dischargeCut' ? a.kwh * fa : 0);
            offer(kind, a, b, fa, fb, -(a.dSek * fa + b.dSek * fb) - wearRate * discharged);
          }
        }
      }
    }

    // Car: the same charge in another hour.
    const carFrom = offersOf(q => d.ev_w[q], -1), carTo = offersOf(q => carMaxW - d.ev_w[q], 1);
    const carRoom = rangeMin(q => carLimitKwh - sim.evKwh[q]);
    for (let f = 0; f < BLOCKS; f++) {
      if (!carFrom[f].length) continue;
      for (let t = 0; t < BLOCKS; t++) {
        if (t === f || !carTo[t].length) continue;
        const limit = t < f ? carRoom[t * BLOCKS + f - 1] / h.car.battery.charge_efficiency : Infinity;
        for (const a of carFrom[f]) for (const b of carTo[t]) {
          const kwh = Math.min(a.kwh, b.kwh, limit);
          if (kwh >= MIN_KWH) offer('ev_move', a, b, kwh / a.kwh, kwh / b.kwh, -(a.dSek * kwh / a.kwh + b.dSek * kwh / b.kwh));
        }
      }
    }

    // Pool: the heat pump off for quarters of one hour, and on in another hour for as many as it takes to end as warm.
    const heaterOn = (q: number) => d.pool_w[q] >= poolOn.draw_w - 1;
    const poolFrom = offersOf(q => heaterOn(q) ? d.pool_w[q] : 0, -1).map(list => list.filter(o => o.variant === 1 || list.length === 1));
    const poolTo = offersOf(q => d.pool_w[q] < 1 ? poolOn.draw_w : 0, 1).map(list => list.filter(o => o.variant === 1 || list.length === 1));
    const running = (o: Offer) => o.w.filter(w => w > 0).length;
    for (let f = 0; f < BLOCKS; f++) {
      const a = poolFrom[f][0];
      if (!a) continue;
      const heat = running(a) * quarterHeatKwh;
      for (let t = 0; t < BLOCKS; t++) {
        const b = poolTo[t][0];
        if (t === f || !b) continue;
        const capacity = running(b) * quarterHeatKwh;
        // Heat put in earlier leaks for longer, so more of it is needed; later, less.
        const needed = heat * Math.exp((f - t) * BLOCK * HOURS / poolTauH);
        if (capacity <= 0 || needed <= 0) continue;
        const fa = Math.min(1, capacity / needed), fb = needed * fa / capacity;
        offer('pool_move', a, b, fa, fb, -(a.dSek * fa + b.dSek * fb));
      }
    }
    return [...buckets.values()].sort((x, y) => y.est - x.est || x.key.localeCompare(y.key));
  };

  const run = (d: Decisions) => { trials++; return simulate(c, h, d); };

  /** An alternative's saving over the working plan, or null when it breaks a guard. */
  const judge = (sim: Simulation): { grid: number; wear: number } | null => {
    if (sim.violations.length) return null;
    if (Math.abs(sim.batteryKwh[last] - original.batteryKwh[last]) > END_TOLERANCE_KWH) return null;
    if (Math.abs(sim.evKwh[last] - original.evKwh[last]) > END_TOLERANCE_KWH) return null;
    const warmer = sim.poolC[last] - original.poolC[last];
    if (warmer < -1e-9 || warmer > POOL_END_TOLERANCE_C) return null;
    if (!serviceNotWorse(plan.exposure, exposureOf(sim))) return null;
    const grid = plan.sim.cost - sim.cost;
    const wear = wearRate * (dischargedOf(sim) - plan.dischargedKwh);
    return grid - wear >= MIN_SAVING_SEK ? { grid, wear } : null;
  };

  type Attempt = { d: Decisions; sim: Simulation; grid: number; wear: number; saving: number; cand: Candidate; fromQ: number[]; toQ: number[]; kwh: number; toShare: number };

  const shift = (values: number[], o: Offer, scale: number, sign: 1 | -1) => {
    const out = [...values];
    for (let k = 0; k < BLOCK; k++) if (o.w[k] > 0) out[o.block * BLOCK + k] = Math.max(0, out[o.block * BLOCK + k] + sign * o.w[k] * scale);
    return out;
  };
  const quartersOf = (o: Offer) => o.w.map((w, k) => w > 0 ? o.block * BLOCK + k : -1).filter(q => q >= 0);

  const attemptBattery = (cand: Candidate, scale: number): Attempt | null => {
    const kind = BATTERY_KINDS.find(k => k.kind === cand.kind)!;
    const d = { ...plan.d };
    const apply = (which: BatterySide, o: Offer, f: number) => {
      const field = which.startsWith('charge') ? 'battery_charge_w' : 'battery_discharge_w';
      d[field] = shift(d[field], o, f * scale, which.endsWith('Add') ? 1 : -1);
    };
    apply(kind.up, cand.a, cand.fa);
    apply(kind.down, cand.b, cand.fb);
    const sim = run(d), verdict = judge(sim);
    if (!verdict) return null;
    // "From" is where the energy came from: the charge of a cycle, the old place of a move.
    const from = cand.kind === 'cycle_add' || cand.kind === 'discharge_move' ? cand.a : cand.b;
    const to = from === cand.a ? cand.b : cand.a;
    const kwh = (from === cand.a ? cand.a.kwh * cand.fa : cand.b.kwh * cand.fb) * scale;
    return { d, sim, ...verdict, saving: verdict.grid - verdict.wear, cand, fromQ: quartersOf(from), toQ: quartersOf(to), kwh, toShare: to.share };
  };

  /** The charger holds whole amps, so the charge moves in whole steps: the dearest quarters give it up first, the cheapest take it. */
  const attemptCar = (cand: Candidate, scale: number, previous: number): { attempt: Attempt | null; movedW: number } => {
    const net = plan.sim.netW, ev = plan.d.ev_w, stepW = carLevels[1].draw_w;
    const perW = (q: number, w: number) => (gridCost(q, net[q] + w) - gridCost(q, net[q])) / w;
    const from = quartersOf(cand.a).sort((x, y) => perW(y, -ev[y]) - perW(x, -ev[x]) || x - y);
    const to = quartersOf(cand.b).sort((x, y) => perW(x, stepW) - perW(y, stepW) || x - y);
    const move = stepMove(ev, from, to, carLevels, cand.a.kwh * cand.fa * scale / KWH);
    // No whole-step move of this size, or the one a larger scale already tried.
    if (!move || move.moved_w === previous) return { attempt: null, movedW: move?.moved_w ?? previous };
    const d = { ...plan.d, ev_w: move.values };
    const sim = run(d), verdict = judge(sim);
    return {
      attempt: verdict && { d, sim, ...verdict, saving: verdict.grid - verdict.wear, cand, fromQ: move.fromQ, toQ: move.toQ, kwh: move.moved_w * KWH, toShare: cand.b.share },
      movedW: move.moved_w,
    };
  };

  const attemptPool = (cand: Candidate, scale: number, previous: number): { attempt: Attempt | null; quarters: number } => {
    const { a, b } = cand, net = plan.sim.netW;
    // Whole running quarters come off, the dearest first.
    const heating = quartersOf(a).sort((x, y) => (gridCost(y, net[y]) - gridCost(y, net[y] - plan.d.pool_w[y])) / plan.d.pool_w[y]
      - (gridCost(x, net[x]) - gridCost(x, net[x] - plan.d.pool_w[x])) / plan.d.pool_w[x] || x - y);
    const count = Math.max(1, Math.ceil(heating.length * cand.fa * scale));
    if (count === previous) return { attempt: null, quarters: count };
    const off = heating.slice(0, count).sort((x, y) => x - y);
    const base = [...plan.d.pool_w];
    let removedKwh = 0;
    for (const q of off) { removedKwh += base[q] * KWH; base[q] = 0; }
    const target = quartersOf(b);
    /** The heat pump on for the first `quarters` of the target hour that are free. */
    const fill = (quarters: number) => {
      const values = [...base], used = target.slice(0, quarters);
      for (const q of used) values[q] = poolOn.draw_w;
      return { values, used };
    };
    // Whole quarters on in the target hour: as many as the heat taken out is still worth there, then one
    // more or fewer until the pool ends no colder than the plan and less than a running quarter warmer.
    let quarters = Math.min(target.length, Math.max(1, Math.round(count * Math.exp((off[0] - target[0]) * HOURS / poolTauH))));
    const tried = new Set<number>();
    while (quarters >= 1 && quarters <= target.length && !tried.has(quarters) && trials < MAX_TRIALS) {
      tried.add(quarters);
      const { values, used } = fill(quarters);
      const d = { ...plan.d, pool_w: values };
      const sim = run(d);
      const miss = sim.poolC[last] - original.poolC[last];
      if (miss >= -1e-9 && miss <= POOL_END_TOLERANCE_C) {
        const verdict = judge(sim);
        if (!verdict) return { attempt: null, quarters: count };
        const share = used.reduce((sum, q) => sum + Math.min(values[q] - base[q], Math.max(0, -net[q] - (base[q] - plan.d.pool_w[q]))), 0)
          / used.reduce((sum, q) => sum + values[q] - base[q], 0);
        return { attempt: { d, sim, ...verdict, saving: verdict.grid - verdict.wear, cand, fromQ: off, toQ: used, kwh: removedKwh, toShare: share }, quarters: count };
      }
      quarters += miss < 0 ? 1 : -1;
    }
    return { attempt: null, quarters: count };
  };

  const attempt = (cand: Candidate): Attempt | null => {
    let quarters = -1, carW = -1;
    for (const scale of SCALES) {
      if (trials >= MAX_TRIALS) return null;
      if (cand.kind === 'pool_move') {
        const result = attemptPool(cand, scale, quarters);
        if (result.attempt) return result.attempt;
        quarters = result.quarters;
      } else if (cand.kind === 'ev_move') {
        const result = attemptCar(cand, scale, carW);
        if (result.attempt) return result.attempt;
        carW = result.movedW;
      } else {
        const result = attemptBattery(cand, scale);
        if (result) return result;
      }
    }
    return null;
  };

  const classify = (t: Attempt): { rule: OpportunityRuleKey; tags: OpportunityRuleKey[]; device: OpportunityDevice } => {
    const { kind, a, b } = t.cand;
    const tagged = (device: OpportunityDevice, ...tags: OpportunityRuleKey[]) => ({ rule: tags[0], tags: [...new Set(tags)], device });
    const later = t.toQ[0] > t.fromQ[0];
    if (kind === 'pool_move') {
      return t.toShare >= 0.5 ? tagged('pool', later ? 'pool_wait_for_sun' : 'pool_solar_preheat', 'pool_cheaper_heating') : tagged('pool', 'pool_cheaper_heating');
    }
    if (kind === 'ev_move') return tagged('ev', 'ev_timing');
    if (kind === 'cycle_cut') return tagged('battery', 'uneconomic_cycling');
    // a stores more, b stores less; for the battery "solar" is charging from what was exported.
    const solar = a.share >= 0.5, offsetsImport = b.share >= 0.5;
    const use: OpportunityRuleKey = offsetsImport ? 'import_avoidable_by_storage' : 'high_value_export';
    if (kind === 'cycle_add') {
      if (a.block > b.block) return solar ? tagged('battery', 'battery_headroom_solar', use) : offsetsImport ? tagged('battery', 'battery_price_spread', use) : tagged('battery', 'high_value_export', 'battery_price_spread');
      if (solar) return offsetsImport ? tagged('battery', 'export_before_import', use) : tagged('battery', 'high_value_export', 'export_before_import');
      return offsetsImport ? tagged('battery', 'battery_price_spread', use) : tagged('battery', 'high_value_export', 'battery_price_spread');
    }
    if (kind === 'charge_move') {
      if (!solar) return tagged('battery', 'battery_price_spread');
      return later ? tagged('battery', 'battery_headroom_solar', 'export_before_import') : tagged('battery', 'export_before_import');
    }
    // discharge_move: the same stored energy against another hour.
    if (!offsetsImport) return tagged('battery', 'high_value_export');
    return later ? tagged('battery', 'battery_preserve', use) : tagged('battery', use);
  };

  type Group = Transfer & { transfers: number };
  const groups: Group[] = [];
  const totals = Object.fromEntries(OPPORTUNITY_RULES.map(r => [r.key, { kwh: 0, known: 0, hindsight: 0, knownQuarters: new Set<number>() }])) as Record<OpportunityRuleKey, { kwh: number; known: number; hindsight: number; knownQuarters: Set<number> }>;
  let limitReached = false, wear = 0;

  const search = (basis: 'known' | 'hindsight') => {
    const rejected = new Set<string>();
    // A device's consecutive transfers under one rule read as one finding. Once MAX_FINDINGS are open,
    // a device's further transfers join its last finding whatever their rule, so the search is never
    // cut short to save space; each rule's money is still counted transfer by transfer.
    const open: Partial<Record<OpportunityDevice, Group>> = {};
    let accepted = 0, opened = 0;
    for (;;) {
      const candidates = candidatesOf(basis, rejected);
      if (!candidates.length) return;
      if (trials >= MAX_TRIALS || accepted >= MAX_TRANSFERS) { limitReached = true; return; }
      let best: Attempt | null = null;
      for (const cand of candidates) {
        if (best && best.saving >= cand.est) break;
        if (trials >= MAX_TRIALS) break;
        const result = attempt(cand);
        if (!result) { rejected.add(cand.key); continue; }
        if (!best || result.saving > best.saving) best = result;
      }
      if (!best) continue;
      const label = classify(best);
      const t: Transfer = {
        ...label, basis, kwh: best.kwh, grid: best.grid, wear: best.wear,
        from: best.fromQ[0], fromEnd: best.fromQ[best.fromQ.length - 1], to: best.toQ[0], toEnd: best.toQ[best.toQ.length - 1],
        before: plan.sim, after: best.sim,
      };
      const saving = t.grid - t.wear, total = totals[t.rule];
      total.kwh += t.kwh;
      total[basis] += saving;
      if (basis === 'known') for (const q of [...best.fromQ, ...best.toQ]) total.knownQuarters.add(q);
      wear += t.wear;
      const g = open[t.device];
      if (g && (g.rule === t.rule || opened >= MAX_FINDINGS)) {
        g.from = Math.min(g.from, t.from); g.fromEnd = Math.max(g.fromEnd, t.fromEnd);
        g.to = Math.min(g.to, t.to); g.toEnd = Math.max(g.toEnd, t.toEnd);
        g.kwh += t.kwh; g.grid += t.grid; g.wear += t.wear; g.after = t.after; g.transfers++;
        g.tags = [...new Set([...g.tags, ...t.tags])];
      } else {
        groups.push(open[t.device] = { ...t, transfers: 1 });
        opened++;
      }
      plan = planOf(best.d, best.sim);
      accepted++;
    }
  };
  search('known');
  if (published < QUARTERS) search('hindsight');

  // A finding changes its own device's store and no other, so that is the trace it keeps.
  const trace = (sim: Simulation, device: OpportunityDevice): OpportunityTrace => ({
    poolC: device === 'pool' ? Array.from(sim.poolC, r3) : [],
    carKm: device === 'ev' ? Array.from(sim.evKwh, v => r1(v / h.car.battery.kwh_per_km)) : [],
    homeSoc: device === 'battery' ? Array.from(sim.batteryKwh, v => r1(v / h.battery.capacity_kwh * 100)) : [],
  });
  const rules = emptyRules();
  let known = 0, hindsight = 0;
  for (const rule of OPPORTUNITY_RULES) {
    const total = totals[rule.key];
    known += total.known; hindsight += total.hindsight;
    rules[rule.key] = { findings: 0, kwh: r3(total.kwh), knownSek: r4(total.known), hindsightSek: r4(total.hindsight), knownQuarters: [...total.knownQuarters].sort((a, b) => a - b) };
  }
  const count = { known: 0, hindsight: 0 };
  const findings: OpportunityFinding[] = groups.map(g => {
    const saving = g.grid - g.wear;
    for (const tag of g.tags) rules[tag].findings++;
    return {
      id: `${g.basis === 'known' ? 'k' : 'h'}${++count[g.basis]}`, rule: g.rule, tags: g.tags, device: g.device,
      from: g.from, fromEnd: g.fromEnd, to: g.to, toEnd: g.toEnd, kwh: r3(g.kwh),
      savingSek: r4(saving), gridSavingSek: r4(g.grid), wearSek: r4(g.wear), basis: g.basis, transfers: g.transfers,
      before: trace(g.before, g.device), after: trace(g.after, g.device),
    };
  });


  return { improved: plan.d, audit: {
    ...core, status: 'complete', reason: null,
    improvedCostSek: r4(plan.sim.cost), avoidableSek: r4(known + hindsight), knownSek: r4(known), hindsightSek: r4(hindsight), wearSek: r4(wear),
    trials, limitReached, rules, findings, violations: [],
  } };
}
