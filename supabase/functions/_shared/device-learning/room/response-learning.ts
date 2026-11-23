/** One room response for every eligible transition in a chronological capture.
 * The exact interval-mean solver owns identification and unexplained heat.
 * Complete heating events are assessed only after the shared fit. */
import {
  advanceIndependentRoomBandCell, finalizeIndependentRoomBand, fitIndependentRoomBandCell,
  prepareIndependentRoomBand, ROOM_BAND_FIT_CELL_COUNT,
  type PreparedIndependentRoomBand, type RoomBandFitCell, type RoomHeatFitState, type RoomMeanQuarter,
} from "./mean-observations.ts";
import { assessRoomHeatingRuns, type RoomTransitionRunLedger } from "./run-calibration.ts";
import { ROOM_TRANSITION_POLICY } from "../../planner/models/room/run-evidence.ts";
export { ROOM_TRANSITION_POLICY };

export const ROOM_RESPONSE_CELL_COUNT = ROOM_BAND_FIT_CELL_COUNT;
export interface RoomResponseEvidence {
  fullRows: RoomMeanQuarter[];
  /** Same chronological prefix, qualified using only facts available in it. */
  trainingRows: RoomMeanQuarter[];
}

/** Split at an observed native interval boundary before reading any training
 * outcomes. Mixed-resolution histories give every observed hour equal weight. */
export function roomResponseTrainingLength(durations: readonly (900 | 3600)[]): number {
  const total = durations.reduce<number>((sum, s) => sum + s, 0);
  let elapsed = 0;
  for (let i = 0; i < durations.length; i++) {
    elapsed += durations[i];
    if (elapsed * 3 >= total * 2) return i + 1;
  }
  return durations.length;
}

export function prepareRoomResponse({ fullRows, trainingRows }: RoomResponseEvidence, ratedPowerW: number | null): PreparedIndependentRoomBand {
  if (trainingRows.length !== roomResponseTrainingLength(fullRows.map(row => row.duration_s ?? 900)) ||
    fullRows.some((row, i) => i > 0 && row.start_ms <= fullRows[i - 1].start_ms) ||
    trainingRows.some((row, i) => row.start_ms !== fullRows[i].start_ms || (row.duration_s ?? 900) !== (fullRows[i].duration_s ?? 900))) {
    throw new Error("Invalid chronological room training prefix");
  }
  return prepareIndependentRoomBand(fullRows, null, ratedPowerW, trainingRows);
}

export interface RoomResponseBatch {
  /** Newly completed cells, contiguous from the persisted cursor. */
  cells: RoomBandFitCell[];
  /** Partial state of the next cell, or null at a cell boundary. */
  state: RoomHeatFitState | null;
}

/** Advance chronological training/full cells under one request budget. Even
 * with no remaining time the first microstep makes checkpointable progress. */
export function advanceRoomResponseCells(prepared: PreparedIndependentRoomBand, completed: readonly RoomBandFitCell[],
  state: RoomHeatFitState | null, budgetMs: number): RoomResponseBatch {
  const started = performance.now(), cells: RoomBandFitCell[] = [];
  let cursor = completed.length;
  if (cursor >= ROOM_RESPONSE_CELL_COUNT) throw new Error("Room response cells are already complete");
  do {
    const remaining = Math.max(0, budgetMs - (performance.now() - started));
    const step = advanceIndependentRoomBandCell(prepared, cursor, state, remaining);
    state = step.state;
    if (step.cell) { cells.push(step.cell); cursor++; }
  } while (cursor < ROOM_RESPONSE_CELL_COUNT && performance.now() - started < budgetMs);
  return { cells, state };
}

export type LearnedRoomResponse = ReturnType<typeof finalizeIndependentRoomBand> & { run_ledger: RoomTransitionRunLedger | null };

export function finalizeRoomResponse(prepared: PreparedIndependentRoomBand, cells: RoomBandFitCell[]): LearnedRoomResponse {
  const fit = finalizeIndependentRoomBand(prepared, cells, { forecastOnly: true });
  if (!fit.result.ok) return { ...fit, run_ledger: null };
  const evidence = fit.result.learning_evidence!;
  const noise = evidence.additional_heat?.selected ? evidence.additional_heat.clean_noise_c : evidence.conditional_residual_std_c!;
  const run_ledger = assessRoomHeatingRuns(prepared.observed, fit.result.model, noise, evidence.forecast_nuisance!.fitted_offset);
  return { ...fit, run_ledger, result: { ...fit.result, learning_evidence: { ...evidence,
    transition_calibration: { policy: ROOM_TRANSITION_POLICY, fitted_transitions: fit.result.model.sample_count } } } };
}

/** Offline callers run precisely the same cells as the durable room worker. */
export function learnRoomResponse(evidence: RoomResponseEvidence, ratedPowerW: number | null): LearnedRoomResponse {
  const prepared = prepareRoomResponse(evidence, ratedPowerW);
  return finalizeRoomResponse(prepared, Array.from({ length: ROOM_RESPONSE_CELL_COUNT }, (_, i) => fitIndependentRoomBandCell(prepared, i)));
}
