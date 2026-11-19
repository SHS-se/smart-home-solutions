import type { ThermalZoneModel } from "./models/room/thermal.ts";
import { readThermalModel } from "./models/room/read-model.ts";

export const HEATING_BAND_WIDTH_C = 5;
export const heatingBand = (outdoorC: number): number =>
  Math.floor(outdoorC / HEATING_BAND_WIDTH_C) * HEATING_BAND_WIDTH_C;

export interface HeatingBandRevision {
  revision: string;
  band_c: number;
  observed_min_c: number;
  observed_max_c: number;
  training_from: string;
  training_to: string;
}

export interface RoomHeatingBand extends HeatingBandRevision {
  model: ThermalZoneModel;
  learning_evidence?: unknown;
  warnings?: string[];
}

export interface RoomHeatingBands {
  binding: string;
  since: string;
  reference_revision: string | null;
  previous_reference_revision?: string;
  reference?: RoomHeatingReference;
  active: RoomHeatingBand[];
  // Frozen candidates are private learning state, never used for planning.
  candidates: RoomHeatingBand[];
  attempted: Record<string, string>;
  window_attempts?: Record<string, string>;
  window_last_attempted_at?: Record<string, string>;
  window_solar_pending?: Record<string, boolean>;
  /** Missing provider hours retry on the normal daily learning cadence. */
  window_solar_retry_at?: Record<string, string | null>;
  window_evidence_updated_at?: Record<string, string>;
  window_solar_progress?: Record<string, { from_at: string; through_at: string; to_at: string }>;
  general_attempt?: { implementation: string; evidence_updated_at: string; from_at: string; to_at: string; attempted_at?: string };
  general_solar_pending?: boolean;
  general_solar_retry_at?: string | null;
  pending_windows?: number;
  diagnostics?: Record<string, unknown>;
}

export interface RoomHeatingReference {
  model: ThermalZoneModel;
  training_to?: string;
  scope?: { kind: "general" } | { kind: "band"; band_c: number };
  passive_heat?: unknown;
  doorway_exchange?: unknown;
}

export interface RoomHeatingBasis {
  reference_revision: string | number | null;
  active: RoomHeatingBand[];
  by_quarter: number[];
}

export type HeatingModelSource =
  | { kind: "band"; band_c: number; revision: string }
  | { kind: "general"; revision: string | number | null }
  | { kind: "weather_curve"; revision: string | number | null; anchors_c: number[] }
  | { kind: "running_power"; watts: number; revision?: string; binding?: string }
  | { kind: "empirical" };

export type HeatingModelRun = { from: number; through: number; source: HeatingModelSource };
export interface RoomHeatingModelUse {
  thermal: HeatingModelRun[];
  electrical: Record<string, HeatingModelRun[]>;
  baseline?: { thermal: HeatingModelRun[]; electrical: Record<string, HeatingModelRun[]> };
}

export function heatingModelRuns(sources: HeatingModelSource[]): HeatingModelRun[] {
  const runs: HeatingModelRun[] = [];
  let previous: string | undefined;
  for (const [index, source] of sources.entries()) {
    const key = JSON.stringify(source);
    if (key === previous) runs[runs.length - 1].through = index;
    else runs.push({ from: index, through: index, source });
    previous = key;
  }
  return runs;
}

export function roomHeatingBandAt(bands: readonly RoomHeatingBand[], outdoorC: number): RoomHeatingBand | undefined {
  return bands.find(band => band.band_c === heatingBand(outdoorC) &&
    outdoorC >= band.observed_min_c && outdoorC <= band.observed_max_c);
}

/** New fits take precedence in their measured range. Keep older evidence
 * for temperatures the new revision did not observe. */
export function publishHeatingBand<T extends HeatingBandRevision>(active: readonly T[], candidate: T): T[] {
  const ordered = [candidate, ...active.filter(point => point.revision !== candidate.revision)]
    .sort((a, b) => a.band_c - b.band_c || Date.parse(b.training_to) - Date.parse(a.training_to) ||
      Date.parse(b.training_from) - Date.parse(a.training_from));
  return ordered.filter((point, index) => !ordered.slice(0, index).some(newer =>
    newer.band_c === point.band_c && newer.observed_min_c <= point.observed_min_c &&
    newer.observed_max_c >= point.observed_max_c));
}

export function formatHeatingRange(min: number, max: number, format: (value: number) => string) {
  return min === max ? `${format(min)} °C` : `${format(min)} – ${format(max)} °C`;
}

export function readRoomHeatingBands(value: unknown): RoomHeatingBands | undefined {
  if (typeof value !== "object" || value === null) return;
  const library = value as RoomHeatingBands;
  if (typeof library.binding !== "string" || !Number.isFinite(Date.parse(library.since)) ||
    !(library.reference_revision === null || typeof library.reference_revision === "string") ||
    !Array.isArray(library.active) || !Array.isArray(library.candidates) || !library.attempted ||
    typeof library.attempted !== "object") return;
  const model = readThermalModel(library.reference?.model);
  const reference = model ? { ...library.reference, model } : undefined;
  const attempt = library.general_attempt;
  let general_attempt: RoomHeatingBands["general_attempt"];
  if (attempt && typeof attempt.implementation === "string" &&
    [attempt.evidence_updated_at, attempt.from_at, attempt.to_at].every(at => typeof at === "string" && Number.isFinite(Date.parse(at)))) {
    const { attempted_at, ...evidence } = attempt;
    general_attempt = typeof attempted_at === "string" && Number.isFinite(Date.parse(attempted_at))
      ? { ...evidence, attempted_at } : evidence;
  }
  return { ...library, reference, ...(attempt !== undefined ? { general_attempt } : {}),
    active: readFits(library.active), candidates: readFits(library.candidates) };
}

function readFits(points: RoomHeatingBand[]): RoomHeatingBand[] {
  return points.flatMap(point => {
    if (!point || typeof point.revision !== "string" || !point.revision ||
      !Number.isFinite(point.band_c) || !Number.isFinite(point.observed_min_c) || !Number.isFinite(point.observed_max_c) ||
      point.observed_min_c > point.observed_max_c || heatingBand(point.observed_min_c) !== point.band_c ||
      heatingBand(point.observed_max_c) !== point.band_c ||
      !(Date.parse(point.training_from) < Date.parse(point.training_to))) return [];
    const model = readThermalModel(point.model);
    return model ? [{ ...point, model }] : [];
  });
}
