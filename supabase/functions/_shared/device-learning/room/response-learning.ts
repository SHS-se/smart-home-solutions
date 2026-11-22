/** One policy owner for general and weather-band responses. Screening and
 * final fitting use independent training partitions and bounded worker cells. */
import {
  advanceIndependentRoomBandCell, finalizeIndependentRoomBand,
  prepareIndependentRoomBand, roomTransitionNoiseReference, ROOM_BAND_FIT_CELL_COUNT, ROOM_MEAN_LEARNING_METHOD, ROOM_EXCHANGE_FAMILY,
  type PreparedIndependentRoomBand, type RoomBandFitCell, type RoomHeatFitState, type RoomMeanQuarter,
} from "./mean-observations.ts";
import { calibrateRoomRuns, recentRoomRunRows, roomHeatingRuns, ROOM_RUN_POLICY, type RoomRunEvidence } from "./run-calibration.ts";

export const ROOM_RESPONSE_CELL_COUNT = ROOM_BAND_FIT_CELL_COUNT * 2;
export interface PreparedRoomResponse {
  source: PreparedIndependentRoomBand;
  workingRows: RoomMeanQuarter[];
  outdoor: (c: number) => boolean;
  ratedPowerW: number | null;
  observedRunCount: number;
}

export function prepareRoomResponse(rows: RoomMeanQuarter[], outdoor: (c: number) => boolean, ratedPowerW: number | null,
  observedRunCount = roomHeatingRuns(rows, outdoor).length) {
  const workingRows = recentRoomRunRows(rows, outdoor);
  return { workingRows, source: prepareIndependentRoomBand(workingRows, outdoor, ratedPowerW), outdoor, ratedPowerW,
    observedRunCount };
}

function fullOnly(cells: readonly RoomBandFitCell[], partition: "training" | "full"): RoomBandFitCell[] {
  return cells.filter(cell => cell.partition === partition).flatMap(cell => [
    { ...cell, partition: "training" as const }, { ...cell, partition: "full" as const },
  ]);
}

/** Estimate the screening boundary from the latest minimum cohort, not a
 * mixture of pre- and post-renovation physics. Older events can join only
 * when their independently measured responses agree with this recent seed. */
function screeningDesign(prepared: PreparedRoomResponse) {
  const source = prepared.source;
  const rows = recentRoomRunRows(source.rows, prepared.outdoor, 3);
  const trainingRows = recentRoomRunRows(source.trainingRows, prepared.outdoor, 3);
  return { ...source, rows, trainingRows,
    noiseReference: { full: roomTransitionNoiseReference(rows, source.solar, source.band),
      training: roomTransitionNoiseReference(trainingRows, source.solar, source.band) } };
}

function screened(prepared: PreparedRoomResponse, cells: readonly RoomBandFitCell[]) {
  const source = prepared.source;
  const seed = screeningDesign(prepared);
  const full = finalizeIndependentRoomBand(seed, cells.slice(0, ROOM_BAND_FIT_CELL_COUNT));
  const trainingDesign = { ...seed, rows: seed.trainingRows, validationRows: seed.trainingRows,
    validationComparableRows: seed.trainingRows, split: seed.trainingRows.length };
  const training = finalizeIndependentRoomBand(trainingDesign, fullOnly(cells.slice(0, ROOM_BAND_FIT_CELL_COUNT), "training"));
  const noise = (fit: typeof full) => fit.result.ok ? fit.result.learning_evidence?.additional_heat?.selected
    ? fit.result.learning_evidence.additional_heat.clean_noise_c : fit.result.model.residual_std_c : 0;
  const selected = full.result.ok ? calibrateRoomRuns(source.rows, full.result.model, prepared.outdoor, noise(full)) : null;
  const trainSelected = training.result.ok ? calibrateRoomRuns(source.trainingRows, training.result.model, prepared.outdoor, noise(training)) : null;
  const keep = new Set(selected?.rows.map(row => row.start_ms));
  const trainKeep = new Set(trainSelected?.rows.map(row => row.start_ms));
  const mask = (rows: RoomMeanQuarter[], allowed: Set<number>) => rows.map(row =>
    allowed.has(row.start_ms) ? row : { ...row, room_c: null });
  const rows = mask(source.rows, keep);
  const trainingRows = mask(source.trainingRows, trainKeep);
  const final = prepareIndependentRoomBand(rows, prepared.outdoor, prepared.ratedPowerW);
  // Preserve capture positions and chronological cut. Held-out outcomes never
  // select training support, calibrate its noise or certify an initial state.
  final.solar = source.solar;
  final.split = source.split;
  final.trainingRows = trainingRows;
  final.validationRows = [...trainingRows, ...source.validationRows.slice(source.split)];
  final.validationComparableRows = final.validationRows;
  final.noiseReference = { training: roomTransitionNoiseReference(trainingRows, source.solar, source.band),
    full: roomTransitionNoiseReference(final.rows, source.solar, source.band) };
  return { prepared: final, selection: selected, screening: full };
}

/** Phase one estimates shared physics with unknown heat as a nuisance.
 * Phase two refits the common on/off
 * support after excluding suspect whole events and their tails. */
export function advanceRoomResponseCell(prepared: PreparedRoomResponse, completed: readonly RoomBandFitCell[],
  state: RoomHeatFitState | null, maxElapsedMs = 200): ReturnType<typeof advanceIndependentRoomBandCell> {
  const started = performance.now(), cursor = completed.length;
  // This derived design is immutable for a cell. Reuse it across micro-batches
  // rather than repeating screening and evidence preparation in one request.
  const design = cursor < ROOM_BAND_FIT_CELL_COUNT ? screeningDesign(prepared) : screened(prepared, completed).prepared;
  const index = cursor % ROOM_BAND_FIT_CELL_COUNT;
  let step = advanceIndependentRoomBandCell(design, index, state);
  while (!step.cell && performance.now() - started < maxElapsedMs) step = advanceIndependentRoomBandCell(design, index, step.state);
  return step;
}

export type LearnedRoomResponse = ReturnType<typeof finalizeIndependentRoomBand> & { run_ledger: RoomRunEvidence | null };

export function finalizeRoomResponse(prepared: PreparedRoomResponse, cells: readonly RoomBandFitCell[]): LearnedRoomResponse {
  if (cells.length !== ROOM_RESPONSE_CELL_COUNT) throw new Error("Room response calibration is incomplete");
  const screenedFit = screened(prepared, cells);
  const fit = finalizeIndependentRoomBand(screenedFit.prepared, cells.slice(ROOM_BAND_FIT_CELL_COUNT), { forecastOnly: true });
  let ledger = screenedFit.selection ? { ...screenedFit.selection.evidence, observed_runs: prepared.observedRunCount } : null;
  if (ledger && fit.result.ok) {
    const noise = fit.result.learning_evidence?.additional_heat?.selected
      ? fit.result.learning_evidence.additional_heat.clean_noise_c : fit.result.learning_evidence?.conditional_residual_std_c ?? fit.result.model.residual_std_c;
    const verified = calibrateRoomRuns(screenedFit.selection!.rows, fit.result.model, prepared.outdoor, noise,
      fit.result.learning_evidence?.forecast_nuisance?.fitted_offset).evidence;
    const ids = (evidence: RoomRunEvidence) => evidence.runs.filter(run => run.disposition === "fitted").map(run => run.id).sort();
    if (JSON.stringify(ids(verified)) !== JSON.stringify(ids(ledger))) return {
      ...fit, run_ledger: { ...ledger, fitted_runs: 0, provisional_runs: ledger.provisional_runs + ledger.fitted_runs, oldest_run_at: null, newest_run_at: null, runs: ledger.runs.map(run => run.disposition === "fitted"
        ? { ...run, disposition: "provisional" as const } : run) },
      result: { ok: false, reason: "response_unresolved", sample_count: fit.result.model.sample_count,
        learning_evidence: { ...fit.result.learning_evidence!, run_calibration: { ...compactRunEvidence(ledger), fitted_runs: 0, provisional_runs: ledger.provisional_runs + ledger.fitted_runs, oldest_run_at: null, newest_run_at: null } } },
    };
    const verifiedById = new Map(verified.runs.map(run => [run.id, run]));
    ledger = { ...ledger, oldest_run_at: verified.oldest_run_at, newest_run_at: verified.newest_run_at,
      runs: ledger.runs.map(run => verifiedById.get(run.id) ?? run) };
  }
  if (!ledger || ledger.fitted_runs < 3 || !fit.result.ok) return {
    ...fit, run_ledger: ledger,
    result: { ok: false, reason: prepared.observedRunCount < 3 ? "insufficient_heating_runs"
      : !screenedFit.screening.result.ok ? screenedFit.screening.result.reason
      : ledger && ledger.fitted_runs < 3 ? "insufficient_heating_runs" : fit.result.ok ? "insufficient_heating_runs" : fit.result.reason, sample_count: fit.result.ok ? fit.result.model.sample_count : fit.result.sample_count,
      learning_evidence: { ...(fit.result.learning_evidence ?? screenedFit.screening.result.learning_evidence)!,
        run_calibration: ledger ? compactRunEvidence(ledger) : undefined } },
  };
  return { ...fit, run_ledger: ledger, result: { ...fit.result,
    warnings: fit.result.warnings?.filter(code => code !== "insufficient_samples" && code !== "insufficient_heating"),
    learning_evidence: { ...fit.result.learning_evidence!, run_calibration: compactRunEvidence(ledger) } } };
}

export function compactRunEvidence(evidence: RoomRunEvidence) {
  const { runs: _runs, ...summary } = evidence;
  return summary;
}

/** Offline replay uses the same cells, not a separate fitting algorithm. */
export function learnRoomResponse(rows: RoomMeanQuarter[], outdoor: (c: number) => boolean, ratedPowerW: number | null): LearnedRoomResponse {
  const prepared = prepareRoomResponse(rows, outdoor, ratedPowerW), cells: RoomBandFitCell[] = [];
  if (prepared.observedRunCount < 3) {
    const ledger: RoomRunEvidence = { policy: ROOM_RUN_POLICY, minimum_runs: 3, maximum_runs: 10,
      observed_runs: prepared.observedRunCount, retained_runs: 0, fitted_runs: 0, suspect_runs: 0, provisional_runs: 0,
      oldest_run_at: null, newest_run_at: null, runs: [] };
    return { minC: null, maxC: null, run_ledger: ledger, result: { ok: false, reason: "insufficient_heating_runs",
      sample_count: prepared.source.usable.length, learning_evidence: { method: ROOM_MEAN_LEARNING_METHOD,
        family: ROOM_EXCHANGE_FAMILY, observation: prepared.source.observation, selection: "chronological_transition_mse",
        training_pairs: 0, validation_pairs: 0, validation_mse_c2: null, selected_boundary: null, selected_lag_h: null,
        ...prepared.source.evidence, run_calibration: compactRunEvidence(ledger) } } };
  }
  while (cells.length < ROOM_RESPONSE_CELL_COUNT) {
    let state: RoomHeatFitState | null = null;
    for (;;) {
      const step = advanceRoomResponseCell(prepared, cells, state);
      if (step.cell) { cells.push(step.cell); break; }
      state = step.state;
    }
  }
  return finalizeRoomResponse(prepared, cells);
}

export { ROOM_RUN_POLICY };
