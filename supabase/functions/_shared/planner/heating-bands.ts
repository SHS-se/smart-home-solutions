import { hasRoomRunSupport } from "./models/room/run-evidence.ts";
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
  fitted_at?: string;
  learning_evidence?: unknown;
}

export interface RoomHeatingBand extends HeatingBandRevision {
  model: ThermalZoneModel;
  learning_evidence?: unknown;
  warnings?: string[];
}

export interface RoomHeatingBands {
  binding: string;
  calibration_policy?: string;
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
  /** The latest shared-response attempt over the exact harvested run pool. */
  shared_attempt?: { implementation: string; pool: { window_key: string; sha256: string }[]; attempted_at: string;
    status: "fitted" | "unidentified" };
  diagnostics?: Record<string, unknown>;
}

export interface RoomHeatingReference {
  model: ThermalZoneModel;
  training_from?: string;
  training_to?: string;
  warnings?: string[];
  /** `shared`: one response fitted across every outdoor temperature. `general`
   * and `band` are legacy responses kept only until the shared one publishes. */
  scope?: { kind: "shared" } | { kind: "general" } | { kind: "band"; band_c: number };
  learning_evidence?: unknown;
  passive_heat?: unknown;
  doorway_exchange?: unknown;
}

export interface RoomHeatingBasis {
  reference_revision: string | number | null;
  active: RoomHeatingBand[];
  by_quarter: number[];
  /** True only when that quarter uses a response beyond its observed range. */
  extrapolated_by_quarter?: boolean[];
}

/** Band attempts have their own dated evidence and do not describe the general fit. */
export function generalRoomFitWarnings(attempt: unknown): string[] | undefined {
  const fit = attempt as { at?: string; status?: string; issues?: string[] } | null | undefined;
  return fit?.at === undefined && fit?.status === "limited" && Array.isArray(fit.issues) ? fit.issues : undefined;
}

/** Qualify the fits actually used by the forecast. A temperature projection
 * crosses quarters, so an unsupported response anywhere in that trajectory
 * cannot justify ahead-of-time heating. The learner owns the evidence limits. */
export function roomHeatingEvidenceLimited(basis: RoomHeatingBasis | undefined, referenceWarnings?: readonly string[]): boolean {
  const limited = (warnings?: readonly string[]) => Array.isArray(warnings) &&
    (warnings.includes("insufficient_heating") || warnings.includes("insufficient_samples"));
  if (!basis?.by_quarter.length) return limited(referenceWarnings);
  return basis.by_quarter.some(index => limited(index < 0 ? referenceWarnings : basis.active[index]?.warnings));
}

/** Thermal sources are a room's one response (see planner/room-response.ts);
 * `band` remains for device electrical draw and legacy rollout responses. */
export type HeatingModelSource =
  | { kind: "shared"; revision: string }
  | { kind: "general"; revision: string | number | null }
  | { kind: "band"; band_c: number; revision: string; extrapolated?: true }
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
  return bands.find(band => band.band_c === heatingBand(outdoorC));
}

/** Extrapolation is an explicit use of a qualified response, never a fabricated
 * cold-band fit. Its transition receives the actual forecast temperature. */
export function roomHeatingResponseAt(bands: readonly RoomHeatingBand[], outdoorC: number): RoomHeatingBand | undefined {
  const measured = roomHeatingBandAt(bands, outdoorC);
  if (measured) return measured;
  if (!Number.isFinite(outdoorC)) return;
  const qualified = bands.filter(band => hasRoomRunSupport(band.learning_evidence));
  if (!qualified.length || outdoorC >= Math.min(...qualified.map(band => band.observed_min_c))) return;
  const distance = (band: RoomHeatingBand) => band.observed_min_c - outdoorC;
  return qualified.reduce<RoomHeatingBand | undefined>((best, band) => !best || distance(band) < distance(best) ||
    distance(band) === distance(best) && Date.parse(band.training_to) > Date.parse(best.training_to) ? band : best, undefined);
}

/** One accepted revision owns the whole nominal band. Observed coverage is
 * evidence, not a second partition of that band. Stable ties preserve the
 * received order; publication places its new candidate first. */
export function canonicalHeatingBands<T extends HeatingBandRevision>(points: readonly T[]): T[] {
  const ordered = [...points]
    .sort((a, b) => a.band_c - b.band_c || Number(hasRoomRunSupport(b.learning_evidence)) - Number(hasRoomRunSupport(a.learning_evidence)) ||
      Date.parse(b.fitted_at ?? b.training_to) - Date.parse(a.fitted_at ?? a.training_to) ||
      Date.parse(b.training_from) - Date.parse(a.training_from));
  const seen = new Set<number>();
  return ordered.filter(point => {
    if (seen.has(point.band_c)) return false;
    seen.add(point.band_c);
    return true;
  });
}

export function publishHeatingBand<T extends HeatingBandRevision>(active: readonly T[], candidate: T): T[] {
  return canonicalHeatingBands([candidate, ...active.filter(point => point.revision !== candidate.revision)]);
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
    active: canonicalHeatingBands(readFits(library.active)), candidates: readFits(library.candidates) };
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
