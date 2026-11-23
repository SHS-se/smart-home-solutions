/**
 * The one room response the planner uses at every quarter. A shared response
 * is fitted across every outdoor temperature; the quarter's forecast outdoor
 * temperature is an input to it, never a model selector.
 *
 * Until a room's shared response publishes, its previously accepted response
 * stays in service for the whole forecast (rollout only): the recent general
 * response, else the band covering the median forecast temperature, else the
 * best-supported band. Planning never stops for a room in transition.
 */
import { readRoomHeatingBands, roomHeatingResponseAt, type RoomHeatingBand, type RoomHeatingBands } from "./heating-bands.ts";
import { hasRoomRunSupport, hasRoomTransitionSupport } from "./models/room/run-evidence.ts";
import { hasMeasuredRoomSupport } from "./models/room/measured-evidence.ts";
import type { ThermalZoneModel } from "./models/room/thermal.ts";
import { readThermalModel } from "./models/room/read-model.ts";

export type RoomResponseSource =
  | { kind: "shared"; revision: string }
  | { kind: "general"; revision: string | number | null }
  | { kind: "band"; band_c: number; revision: string };

export interface RoomResponse {
  model: ThermalZoneModel;
  source: RoomResponseSource;
  warnings: string[];
  /** The published response has evidence under its calibration policy. */
  supported: boolean;
  /** A response accepted before the shared response; replaced on publication. */
  legacy: boolean;
  /** Boundary evidence fitted with the general response (legacy only). */
  passive_heat?: unknown;
  doorway_exchange?: unknown;
}

const median = (values: readonly (number | null)[] | null | undefined): number | null => {
  const finite = (values ?? []).filter((value): value is number => typeof value === "number" && Number.isFinite(value))
    .sort((a, b) => a - b);
  return finite.length ? finite[Math.floor(finite.length / 2)] : null;
};

const fittedRuns = (band: RoomHeatingBand): number => {
  const support = (band.learning_evidence as { run_calibration?: { fitted_runs?: unknown } } | undefined)?.run_calibration;
  return hasRoomRunSupport(band.learning_evidence) ? Number(support?.fitted_runs) : 0;
};

export function readRoomResponse(stored: unknown, forecastOutdoorC?: readonly (number | null)[] | null): RoomResponse | null {
  const library = readRoomHeatingBands(stored);
  return library ? roomResponse(library, forecastOutdoorC) : null;
}

export function roomResponse(library: RoomHeatingBands, forecastOutdoorC?: readonly (number | null)[] | null): RoomResponse | null {
  const reference = library.reference;
  const model = readThermalModel(reference?.model);
  if (reference && model && reference.scope?.kind === "shared" && typeof library.reference_revision === "string") {
    return { model, source: { kind: "shared", revision: library.reference_revision }, warnings: reference.warnings ?? [],
      supported: hasMeasuredRoomSupport(reference.learning_evidence) || hasRoomTransitionSupport(reference.learning_evidence) || hasRoomRunSupport(reference.learning_evidence), legacy: false };
  }
  // ---- Rollout only: responses accepted before the shared response. ----
  if (reference && model && reference.scope?.kind !== "band") {
    return { model, source: { kind: "general", revision: library.reference_revision ?? library.previous_reference_revision ?? null },
      warnings: reference.warnings ?? [], supported: hasRoomRunSupport(reference.learning_evidence), legacy: true,
      ...(reference.passive_heat !== undefined ? { passive_heat: reference.passive_heat } : {}),
      ...(reference.doorway_exchange !== undefined ? { doorway_exchange: reference.doorway_exchange } : {}) };
  }
  const typical = median(forecastOutdoorC);
  const band = (typical !== null ? roomHeatingResponseAt(library.active, typical) : undefined) ??
    [...library.active].sort((a, b) => fittedRuns(b) - fittedRuns(a) ||
      Date.parse(b.training_to) - Date.parse(a.training_to) || a.band_c - b.band_c)[0];
  return band ? { model: band.model, source: { kind: "band", band_c: band.band_c, revision: band.revision },
    warnings: band.warnings ?? [], supported: hasRoomRunSupport(band.learning_evidence), legacy: true } : null;
}

/** Fits the learner flagged as resting on too little heating cannot justify preheating. */
export const roomResponseEvidenceLimited = (warnings?: readonly string[]): boolean =>
  Array.isArray(warnings) && (warnings.includes("insufficient_heating") || warnings.includes("insufficient_samples"));
