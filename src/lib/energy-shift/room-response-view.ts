import { z } from 'zod';
import { readConnectedRoomResponse, type ConnectedRoomResponse } from '../../../supabase/functions/_shared/planner/models/room/connected-exchange';
import type { RoomRunDiagnostics } from '../../../supabase/functions/_shared/planner/models/room/run-diagnostics';
import { readThermalModel } from '../../../supabase/functions/_shared/planner/models/room/read-model';
import { isEquilibrium, type DynamicThermalZoneModel, type ThermalZoneModel } from '../../../supabase/functions/_shared/planner/models/room/thermal';
import { roomMeasuredEvidence, roomTransitionEvidence } from './room-run-evidence';
import { readMeasuredRoomAssessmentPage, MEASURED_ROOM_RUN_PAGE_SIZE, readRoomAssessmentPage, ROOM_RUN_PAGE_SIZE, roomRunPoints, trendRun, type RoomRunPoint } from './room-run-points';

import { ROOM_MEASURED_POLICY, type MeasuredRoomAssessment, type MeasuredRoomCalibration } from '../../../supabase/functions/_shared/planner/models/room/measured-evidence';

/** One read of the room Model tab: the published shared response and the run
 * ledger assessed against exactly that revision. The browser evaluates the
 * published model; it never fits a curve of its own. */
const response = z.object({
  revision: z.string(),
  model: z.unknown(),
  connected_exchange: z.unknown().optional(),
  training_from: z.string().nullable().optional(),
  training_to: z.string().nullable().optional(),
  warnings: z.array(z.string()).nullable().optional(),
  measured_runs: z.unknown().optional(),
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
  diagnostics: z.unknown().optional(),
  ledgers: z.array(z.object({ scope_key: z.string(), created_at: z.string(), evidence: z.unknown() }).passthrough()),
});

export interface RoomResponseView {
  response: { revision: string; model: ThermalZoneModel | null; connected?: ConnectedRoomResponse | null; trainingFrom: string | null; trainingTo: string | null;
    warnings: string[]; fittedRuns: number | null; fittedTransitions: number | null; measuredRuns: MeasuredRoomCalibration | null } | null;
  /** Runs assessed against `response`, or legacy per-band assessments during rollout. */
  points: RoomRunPoint[];
  measuredPoints: MeasuredRoomAssessment[];
  diagnostics?: Omit<RoomRunDiagnostics, 'runs'>;
  observedRuns: number | null;
  assessed: 'shared' | 'legacy' | 'descriptive' | null;
  room: z.infer<typeof evidence>['room'];
}

export function readRoomResponseView(data: unknown): RoomResponseView | null {
  const parsed = evidence.safeParse(data);
  if (!parsed.success) return null;
  const { room, ledgers } = parsed.data;
  const model = parsed.data.response ? readThermalModel(parsed.data.response.model) : null;
  const connected = readConnectedRoomResponse(parsed.data.response?.connected_exchange);
  const measured = roomMeasuredEvidence.safeParse(parsed.data.response?.measured_runs);
  const published = parsed.data.response && (model || connected) ? {
    revision: parsed.data.response.revision, model, connected,
    trainingFrom: parsed.data.response.training_from ?? null, trainingTo: parsed.data.response.training_to ?? null,
    warnings: parsed.data.response.warnings ?? [],
    fittedRuns: parsed.data.response.run_calibration?.fitted_runs ?? null,
    fittedTransitions: parsed.data.response.transition_calibration?.fitted_transitions ?? null,
    measuredRuns: measured.success ? measured.data as MeasuredRoomCalibration : null,
  } : null;
  if (parsed.data.diagnostics !== undefined) {
    const summary = z.object({kind: z.literal('current_training_window'), response_revision: z.string(),
      from_at: z.string(), to_at: z.string(), read_at: z.string(),
      calibration: roomMeasuredEvidence.pick({observed_runs: true, heating_runs: true, cooling_runs: true,
        heating_flagged_runs: true, cooling_flagged_runs: true, unmeasured_runs: true}).extend({
          lines: roomMeasuredEvidence.shape.lines.pick({heating: true, cooling: true}),
        }), runs: z.array(z.unknown())}).safeParse(parsed.data.diagnostics);
    if (!published?.connected || !summary.success || summary.data.response_revision !== published.revision ||
      summary.data.from_at !== published.trainingFrom || summary.data.to_at !== published.trainingTo) return null;
    const {runs, ...diagnostics} = summary.data;
    const measuredPoints = readMeasuredRoomAssessmentPage(runs, diagnostics.calibration.observed_runs);
    if (!measuredPoints) return null;
    return {response: published, points: [], measuredPoints, diagnostics: diagnostics as Omit<RoomRunDiagnostics, 'runs'>,
      observedRuns: measuredPoints.length, assessed: 'descriptive', room};
  }
  const shared = ledgers.find(ledger => ledger.scope_key === 'shared');
  const assessedAgainst = (shared?.evidence as { assessed_against?: unknown } | null | undefined)?.assessed_against;
  if (published?.measuredRuns) {
    const ledger = z.object({ policy: z.literal(ROOM_MEASURED_POLICY), assessed_against: z.string(),
      observed_runs: z.number().int().nonnegative(), runs: z.array(z.unknown()) }).safeParse(shared?.evidence);
    if (ledger.success && ledger.data.assessed_against === published.revision) {
      const count = ledger.data.observed_runs;
      const measuredPoints = readMeasuredRoomAssessmentPage(ledger.data.runs, Math.min(count, MEASURED_ROOM_RUN_PAGE_SIZE));
      if (measuredPoints) return { response: published, points: [], measuredPoints, assessed: 'shared', observedRuns: count, room };
    }
    return { response: published, points: [], measuredPoints: [], assessed: null, observedRuns: null, room };
  }
  if (published && published.fittedTransitions !== null) {
    const ledger = z.object({ policy: roomTransitionEvidence.shape.policy, assessed_against: z.string(),
      observed_runs: z.number().int().nonnegative(), runs: z.array(z.unknown()) }).safeParse(shared?.evidence);
    if (ledger.success && ledger.data.assessed_against === published.revision) {
      const count = ledger.data.observed_runs;
      const points = readRoomAssessmentPage(ledger.data.runs, Math.min(count, ROOM_RUN_PAGE_SIZE));
      if (points) return { response: published, points, measuredPoints: [], assessed: 'shared', observedRuns: count, room };
    }
    return { response: published, points: [], measuredPoints: [], assessed: null, observedRuns: null, room };
  }
  if (published && shared && assessedAgainst === published.revision) {
    return { response: published, points: roomRunPoints([shared]).points, measuredPoints: [], assessed: 'shared', observedRuns: null, room };
  }
  // Rollout only: per-band assessments are shown as points without a line.
  const legacy = ledgers.filter(ledger => ledger.scope_key !== 'shared' && ledger.scope_key !== 'attempt');
  const points = roomRunPoints(legacy).points;
  return { response: published, points, measuredPoints: [], assessed: points.length ? 'legacy' : null, observedRuns: null, room };
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

/** Legacy rollout lines evaluated from the published dynamic model. Measured-run
 * charts use their published summaries, never this intrinsic heater parameter. */
export function roomResponseLines(view: RoomResponseView): RoomResponseLines | null {
  const model = view.response?.model;
  if (view.response?.measuredRuns) return null;
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
