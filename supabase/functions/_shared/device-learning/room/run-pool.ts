/** Which heating runs a shared room response is fitted on. Outdoor strata only
 * sample evidence across seasons; they never own coefficients. Pure. */
import type { RoomMeanQuarter } from "./mean-observations.ts";
import { roomIntervalHours } from "./mean-evidence.ts";
import { roomHeatingRuns, rowsForRuns, type HeatingRun } from "./run-calibration.ts";
import { heatingBand } from "../../planner/heating-bands.ts";
import { MAX_ROOM_HEATING_RUNS, RUNS_PER_OUTDOOR_BAND } from "../../planner/models/room/run-evidence.ts";

export const ALL_OUTDOOR = (_c: number) => true;

export interface HarvestedBandRuns {
  band_c: number;
  /** Sparse rows of the kept runs (pre-on context through the off tail). */
  rows: RoomMeanQuarter[];
  run_ids: string[];
  observed_runs: number;
}

/** Newest runs whose heating touched this band, read over the band's window.
 * Rows were qualified over the whole window read, so merges never re-qualify. */
export function harvestBandRuns(rows: readonly RoomMeanQuarter[], band_c: number): HarvestedBandRuns {
  const runs = roomHeatingRuns(rows, c => heatingBand(c) === band_c);
  const kept = runs.slice(-RUNS_PER_OUTDOOR_BAND);
  return { band_c, rows: rowsForRuns(rows, kept), run_ids: kept.map(run => run.id), observed_runs: runs.length };
}

/** Union by interval start. A row in two harvests comes from the later one. */
export function mergeHarvests(entries: readonly { harvested_at: string; rows: readonly RoomMeanQuarter[] }[]): RoomMeanQuarter[] {
  const byStart = new Map<number, RoomMeanQuarter>();
  for (const entry of [...entries].sort((a, b) => Date.parse(a.harvested_at) - Date.parse(b.harvested_at))) {
    for (const row of entry.rows) byStart.set(row.start_ms, row);
  }
  return [...byStart.values()].sort((a, b) => a.start_ms - b.start_ms);
}

/** The stratum of a run: the band of its time-weighted mean outdoor temperature
 * while heating. A run with no outdoor reading forms its own stratum. */
export function runOutdoorBand(rows: readonly RoomMeanQuarter[], run: HeatingRun): number | null {
  let sum = 0, hours = 0;
  for (const row of rows.slice(run.on, run.off)) {
    if (typeof row.outdoor_c !== "number" || !Number.isFinite(row.outdoor_c)) continue;
    sum += row.outdoor_c * roomIntervalHours(row); hours += roomIntervalHours(row);
  }
  return hours > 0 ? heatingBand(sum / hours) : null;
}

/**
 * At most MAX_ROOM_HEATING_RUNS in all, taken round-robin so every season is
 * represented before any gets more; a one-season room keeps all its runs.
 * Strata are visited newest-run first; each round takes the next-newest run
 * of every stratum. Idempotent on its own output.
 */
export function seasonalRunRows(rows: readonly RoomMeanQuarter[]): RoomMeanQuarter[] {
  const runs = roomHeatingRuns(rows, ALL_OUTDOOR);
  const strata = new Map<string, HeatingRun[]>();
  for (const run of runs) {
    const key = String(runOutdoorBand(rows, run));
    strata.set(key, [...(strata.get(key) ?? []), run]);
  }
  const groups = [...strata.entries()].map(([key, group]) =>
    ({ key, runs: group.sort((a, b) => b.on_from_ms - a.on_from_ms).slice(0, RUNS_PER_OUTDOOR_BAND) }))
    .sort((a, b) => b.runs[0].on_from_ms - a.runs[0].on_from_ms || (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));
  const chosen: HeatingRun[] = [];
  for (let round = 0; round < RUNS_PER_OUTDOOR_BAND && chosen.length < MAX_ROOM_HEATING_RUNS; round++) {
    for (const group of groups) {
      if (chosen.length >= MAX_ROOM_HEATING_RUNS) break;
      if (group.runs[round]) chosen.push(group.runs[round]);
    }
  }
  return rowsForRuns(rows, chosen.sort((a, b) => a.on_from_ms - b.on_from_ms));
}
