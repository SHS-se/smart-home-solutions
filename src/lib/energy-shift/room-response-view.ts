import { z } from 'zod';
import { readThermalModel } from '../../../supabase/functions/_shared/planner/models/room/read-model';
import { isEquilibrium, type DynamicThermalZoneModel, type ThermalZoneModel } from '../../../supabase/functions/_shared/planner/models/room/thermal';
import { roomTransitionEvidence } from './room-run-evidence';
import { readRoomAssessmentPage, ROOM_RUN_PAGE_SIZE, roomRunPoints, trendRun, type RoomRunPoint } from './room-run-points';

/** One read of the room Model tab: the published shared response and the run
 * ledger assessed against exactly that revision. The browser evaluates the
 * published model; it never fits a curve of its own. */
const response = z.object({
  revision: z.string(),
  model: z.unknown(),
  training_from: z.string().nullable().optional(),
  training_to: z.string().nullable().optional(),
  warnings: z.array(z.string()).nullable().optional(),
  transition_calibration: roomTransitionEvidence.nullable().optional(),
  run_calibration: z.object({ fitted_runs: z.number().int(), maximum_runs: z.number().int().optional() }).passthrough().nullable().optional(),
}).nullable();
const evidence = z.object({
  room: z.object({
    trained: z.boolean().nullable(),
    rejection_reason: z.string().nullable(),
    last_attempted_at: z.string().nullable().optional(),
    last_fit_attempt: z.unknown().optional(),
    shared_attempt: z.object({ status: z.string(), attempted_at: z.string() }).passthrough().nullable().optional(),
  }).nullable(),
  response,
  ledgers: z.array(z.object({ scope_key: z.string(), created_at: z.string(), evidence: z.unknown() }).passthrough()),
});

export interface RoomResponseView {
  response: { revision: string; model: ThermalZoneModel; trainingFrom: string | null; trainingTo: string | null;
    warnings: string[]; fittedRuns: number | null; fittedTransitions: number | null } | null;
  /** Runs assessed against `response`, or legacy per-band assessments during rollout. */
  points: RoomRunPoint[];
  observedRuns: number | null;
  assessed: 'shared' | 'legacy' | null;
  room: z.infer<typeof evidence>['room'];
}

export function readRoomResponseView(data: unknown): RoomResponseView | null {
  const parsed = evidence.safeParse(data);
  if (!parsed.success) return null;
  const { room, ledgers } = parsed.data;
  const model = parsed.data.response ? readThermalModel(parsed.data.response.model) : null;
  const published = parsed.data.response && model ? {
    revision: parsed.data.response.revision, model,
    trainingFrom: parsed.data.response.training_from ?? null, trainingTo: parsed.data.response.training_to ?? null,
    warnings: parsed.data.response.warnings ?? [],
    fittedRuns: parsed.data.response.run_calibration?.fitted_runs ?? null,
    fittedTransitions: parsed.data.response.transition_calibration?.fitted_transitions ?? null,
  } : null;
  const shared = ledgers.find(ledger => ledger.scope_key === 'shared');
  const assessedAgainst = (shared?.evidence as { assessed_against?: unknown } | null | undefined)?.assessed_against;
  if (published && published.fittedTransitions !== null) {
    const ledger = z.object({ policy: roomTransitionEvidence.shape.policy, assessed_against: z.string(),
      observed_runs: z.number().int().nonnegative(), runs: z.array(z.unknown()) }).safeParse(shared?.evidence);
    if (ledger.success && ledger.data.assessed_against === published.revision) {
      const count = ledger.data.observed_runs;
      const points = readRoomAssessmentPage(ledger.data.runs, Math.min(count, ROOM_RUN_PAGE_SIZE));
      if (points) return { response: published, points, assessed: 'shared', observedRuns: count, room };
    }
    return { response: published, points: [], assessed: null, observedRuns: null, room };
  }
  if (published && shared && assessedAgainst === published.revision) {
    return { response: published, points: roomRunPoints([shared]).points, assessed: 'shared', observedRuns: null, room };
  }
  // Rollout only: per-band assessments are shown as points without a line.
  const legacy = ledgers.filter(ledger => ledger.scope_key !== 'shared' && ledger.scope_key !== 'attempt');
  const points = roomRunPoints(legacy).points;
  return { response: published, points, assessed: points.length ? 'legacy' : null, observedRuns: null, room };
}

export interface RoomResponseLines {
  /** Heater response, °C per kWh delivered: one flat value for every outdoor temperature. */
  heater: { cPerKwh: number; excessScatter: number | null };
  /** Cool-down with the heater off and no sun, at a stated room and house temperature. */
  cooling: {
    reference: { roomC: number; houseC: number };
    at: (outdoorC: number) => number;
    /** Where the room stops cooling unheated, if the line crosses zero. */
    balanceC: number | null;
    /** A run's cool-down moved to the reference conditions: line plus its residual. */
    pointY: (point: RoomRunPoint) => number | null;
  };
  /** Power that holds the reference temperature: cool-down ÷ heater response. */
  holdKw: (outdoorC: number) => number | null;
}

const median = (values: number[]) => {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted.length ? sorted[Math.floor(sorted.length / 2)] : null;
};

/** Lines evaluated from the published dynamic model; algebraic responses have none. */
export function roomResponseLines(view: RoomResponseView): RoomResponseLines | null {
  const model = view.response?.model;
  if (!model || (view.assessed !== 'shared' && view.response!.fittedTransitions === null) || isEquilibrium(model)) return null;
  const dynamic: DynamicThermalZoneModel = model;
  const gain = dynamic.gain_c_per_wh * 1000;
  if (!(gain > 0)) return null;
  const credible = view.points.filter(trendRun);
  const excessScatter = credible.length > 1
    ? Math.sqrt(credible.reduce((sum, p) => sum + ((p.gain! - gain) / p.gainSe!) ** 2, 0) / (credible.length - 1)) : null;
  const cooldowns = view.points.filter(p => p.cooldown);
  // A fixed reference keeps the published line comparable as the diagnostic page changes.
  const chronological = view.response!.fittedTransitions !== null;
  const roomC = chronological ? 20 : median(cooldowns.map(p => p.cooldown!.room_c)) ?? 20;
  const houseC = chronological ? 20 : median(cooldowns.flatMap(p => p.cooldown!.house_c === null ? [] : [p.cooldown!.house_c])) ?? roomC;
  const k = dynamic.cooling_constant_per_h, h = dynamic.house_coupling_per_h ?? 0, b = dynamic.background_gain_c_per_h;
  const at = (outdoorC: number) => k * (roomC - outdoorC) + h * (roomC - houseC) - b;
  const balanceC = k > 0 ? roomC + (h * (roomC - houseC) - b) / k : null;
  return {
    heater: { cPerKwh: gain, excessScatter },
    cooling: { reference: { roomC, houseC }, at, balanceC,
      pointY: p => p.cooldown?.residual_c_per_h == null ? null : at(p.cooldown.outdoor_c) + p.cooldown.residual_c_per_h },
    holdKw: outdoorC => { const loss = at(outdoorC); return loss > 0 ? loss / gain : null; },
  };
}
