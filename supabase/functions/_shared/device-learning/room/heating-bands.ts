import { roomHeatingDirectionKnown } from "./operation-evidence.ts";
import { fitIndependentRoomBand, type RoomMeanQuarter } from "./mean-observations.ts";
import { roomIntervalSeconds } from "./mean-evidence.ts";
import { heatingBand, publishHeatingBand, type RoomHeatingBand, type RoomHeatingBands } from "../../planner/heating-bands.ts";
import type { ThermalZoneModel } from "../../planner/models/room/thermal.ts";

/** Fit one weather range from measured observations. Insufficient identification
 * leaves that range's published revision intact and records the attempt. A band
 * need not outperform a different, general-weather model to describe its data. */
export function advanceRoomHeatingBands(
  library: RoomHeatingBands, observations: RoomMeanQuarter[], _reference: ThermalZoneModel | null, ratedPowerW: number | null,
  history?: { band: number; split: number; lastAt: string },
): RoomHeatingBands {
  const rows = observations.filter(row => row.start_ms >= Date.parse(library.since));
  const newest = new Map<number, number>();
  for (const row of rows) {
    if (row.outdoor_c == null || row.room_c == null || row.heat_w == null || !roomHeatingDirectionKnown(row)) continue;
    if (row.heat_w > 0) newest.set(heatingBand(row.outdoor_c), row.start_ms);
  }
  const eligible = [...newest].filter(([band, at]) => at > Date.parse(library.attempted[band] ?? library.since))
    .sort(([a, atA], [b, atB]) => Date.parse(library.attempted[a] ?? library.since) -
      Date.parse(library.attempted[b] ?? library.since) || atB - atA);
  const next = history ? [history.band, Date.parse(history.lastAt)] as const : eligible[0];
  if (!next || !rows.length) return library;
  const [band, at] = next;
  const fit = fitIndependentRoomBand(rows, outdoor => heatingBand(outdoor) === band, ratedPowerW);
  return publishRoomHeatingBandFit(library, rows, band, at, fit);
}

/** Apply a completed numerical result; incomplete cells never enter this library. */
export function publishRoomHeatingBandFit(
  library: RoomHeatingBands, rows: RoomMeanQuarter[], band: number, at: number,
  fit: ReturnType<typeof fitIndependentRoomBand>,
): RoomHeatingBands {
  if (!rows.length) return library;
  const attempt = { at: new Date(at).toISOString(), status: fit.result.ok ? "fitted" : "unidentified",
    issues: fit.result.ok ? fit.result.warnings ?? [] : [fit.result.reason], learning: fit.result.learning_evidence };
  const updated = { ...library, attempted: { ...library.attempted, [band]: attempt.at },
    diagnostics: { ...library.diagnostics, [band]: attempt },
    candidates: library.candidates.filter(candidate => candidate.band_c !== band) };
  if (!fit.result.ok || fit.minC === null || fit.maxC === null) return updated;
  // Unknown meter history cannot have trained the response. Its temperatures
  // stay in discovery, but do not extend the fitted heater-evidence dates.
  const measured = rows.filter(row => Number.isFinite(row.heat_w) && row.heat_w !== null);
  const first = measured[0]!, last = measured.at(-1)!;
  const candidate: RoomHeatingBand = {
    revision: crypto.randomUUID(), band_c: band, observed_min_c: fit.minC, observed_max_c: fit.maxC,
    training_from: new Date(first.start_ms).toISOString(),
    training_to: new Date(last.start_ms + roomIntervalSeconds(last) * 1000).toISOString(),
    model: fit.result.model, learning_evidence: fit.result.learning_evidence,
    warnings: fit.result.warnings ?? [],
  };
  return { ...updated, active: publishHeatingBand(library.active, candidate) };
}
