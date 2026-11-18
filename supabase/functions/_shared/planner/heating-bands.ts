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
}

export interface RoomHeatingBands {
  binding: string;
  since: string;
  reference_revision: string | null;
  previous_reference_revision?: string;
  active: RoomHeatingBand[];
  // Frozen candidates are private learning state, never used for planning.
  candidates: RoomHeatingBand[];
  attempted: Record<string, string>;
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
  | { kind: "running_power"; watts: number }
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
  return { ...library, active: readFits(library.active), candidates: readFits(library.candidates) };
}

function readFits(points: RoomHeatingBand[]): RoomHeatingBand[] {
  return points.flatMap(point => {
    if (!point || typeof point.revision !== "string" || !point.revision ||
      !Number.isFinite(point.band_c) || !Number.isFinite(point.observed_min_c) || !Number.isFinite(point.observed_max_c) ||
      point.observed_min_c > point.observed_max_c || heatingBand(point.observed_min_c) !== point.band_c ||
      heatingBand(point.observed_max_c) !== point.band_c ||
      !(Date.parse(point.training_from) < Date.parse(point.training_to))) return [];
    const model = readThermalModel(point.model as unknown as Record<string, unknown>);
    return model ? [{ ...point, model }] : [];
  });
}

export function matchingRoomHeatingCoordinates(band: RoomHeatingBand, reference: ThermalZoneModel): boolean {
  const lag = reference.heat_lag_h ?? 0;
  const model = band.model;
  return (model.heat_lag_h ?? 0) === lag &&
    (model.house_coupling_per_h ?? 0) === (reference.house_coupling_per_h ?? 0) &&
    (lag === 0 || model.gain_c_per_wh === reference.gain_c_per_wh);
}
