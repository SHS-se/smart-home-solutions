import { fitRoomBand, roomMeanObservation, type RoomMeanQuarter } from "./mean-observations.ts";
import { HEATED_SAMPLE_MIN_W } from "./regression.ts";
import { heatingBand, roomHeatingBandAt, type RoomHeatingBand, type RoomHeatingBands } from "../../planner/heating-bands.ts";
import type { ThermalZoneModel } from "../../planner/models/room/thermal.ts";
import { addPairedLoss, pairedImprovement, type PairedDay } from "../heating-comparison.ts";

const QUARTER_MS = 900_000;
const EVALUATION_PERIOD_MS = 6 * 3_600_000;

function comparison(
  rows: RoomMeanQuarter[], incumbent: readonly RoomHeatingBand[], proposed: RoomHeatingBand, reference: ThermalZoneModel,
) {
  const from = Date.parse(proposed.training_to);
  const lag = reference.heat_lag_h ?? 0;
  const carry = roomMeanObservation(0, lag).C;
  let delivered = 0, predicted: [number, number] | null = null;
  let previous: RoomMeanQuarter | undefined;
  let observedHeat = false;
  const warming = new Map<number, PairedDay>(), cooldown = new Map<number, PairedDay>();
  for (const row of rows) {
    if (row.start_ms - (previous?.start_ms ?? Infinity) !== QUARTER_MS) {
      delivered = 0;
      observedHeat = false;
      predicted = null;
    }
    if (row.heat_w == null || row.cooling || row.house_c == null || row.outdoor_c == null ||
      row.band_forcing_c_per_h === null ||
      (reference.solar_gain_c_per_h_per_wm2 != null && row.solar_w_per_m2 == null)) {
      previous = undefined;
      continue;
    }
    const phase = row.heat_w > HEATED_SAMPLE_MIN_W ? "warming" : "cooldown";
    if (previous && Math.floor(row.start_ms / EVALUATION_PERIOD_MS) !==
      Math.floor(previous.start_ms / EVALUATION_PERIOD_MS)) {
      predicted = null;
      observedHeat = false;
    }
    observedHeat ||= phase === "warming";
    if (row.start_ms >= from) {
      const model = roomHeatingBandAt(incumbent, row.outdoor_c)?.model ?? reference;
      const inBand = row.outdoor_c >= proposed.observed_min_c && row.outdoor_c <= proposed.observed_max_c;
      const models = [model, inBand ? proposed.model : model] as const;
      const initialized = predicted !== null;
      const endpoints: [number, number] = [0, 0], means: [number, number] = [0, 0];
      if (initialized || row.room_c !== null) {
        for (const [index, physics] of models.entries()) {
          const house = physics.house_coupling_per_h ?? 0;
          const op = roomMeanObservation(house + physics.cooling_constant_per_h, lag);
          const forcing = house * row.house_c + physics.cooling_constant_per_h * row.outdoor_c +
            physics.background_gain_c_per_h + (physics.solar_gain_c_per_h_per_wm2 ?? 0) * (row.solar_w_per_m2 ?? 0) +
            (row.band_forcing_c_per_h ?? 0);
          const addMean = physics.gain_c_per_wh * (op.U * delivered + (op.V - op.U) * row.heat_w) + op.V * forcing;
          const boundary = predicted?.[index] ?? (row.room_c! - addMean) / op.E;
          means[index] = op.E * boundary + addMean;
          endpoints[index] = op.a * boundary + op.effect * forcing +
            physics.gain_c_per_wh * (op.B * delivered + (op.effect - op.B) * row.heat_w);
        }
        predicted = endpoints;
        if (initialized && inBand && observedHeat && row.room_c !== null && means.every(Number.isFinite)) {
          addPairedLoss(phase === "warming" ? warming : cooldown, row.start_ms,
            (means[1] - row.room_c) ** 2, (means[0] - row.room_c) ** 2);
        }
      }
    }
    delivered = carry * delivered + (1 - carry) * row.heat_w;
    previous = row;
  }
  const coolingLossImproved = [...cooldown.values()].reduce((sum, day) => sum + day.sum / day.count, 0) >= 0;
  return { warming: pairedImprovement(warming), cooldown: pairedImprovement(cooldown),
    cooldownHeld: cooldown.size >= 2 && coolingLossImproved };
}

/** Advance one band's candidate. A pending cold-band fit never blocks a warmer band. */
export function advanceRoomHeatingBands(
  library: RoomHeatingBands, observations: RoomMeanQuarter[], reference: ThermalZoneModel, ratedPowerW: number | null,
  history?: { band: number; split: number; lastAt: string },
): RoomHeatingBands {
  const rows = observations.filter(row => row.start_ms >= Date.parse(library.since));
  const newest = new Map<number, number>();
  const pendingBands = new Set(library.candidates.map(candidate => candidate.band_c));
  for (const row of rows) {
    if (row.outdoor_c == null || row.room_c == null || row.heat_w == null || row.cooling) continue;
    const band = heatingBand(row.outdoor_c);
    if (row.heat_w > HEATED_SAMPLE_MIN_W || pendingBands.has(band)) newest.set(band, row.start_ms);
  }
  const eligible = [...newest].filter(([band, at]) => {
    const pending = library.candidates.find(candidate => candidate.band_c === band);
    return at > Date.parse(library.attempted[band] ?? library.since) &&
      (!pending || at >= Date.parse(pending.training_to));
  })
    .sort(([a], [b]) => Date.parse(library.attempted[a] ?? library.since) -
      Date.parse(library.attempted[b] ?? library.since) || (newest.get(b)! - newest.get(a)!));
  const next = history ? [history.band, Date.parse(history.lastAt)] as const : eligible[0];
  if (!next) return library;
  const [band, at] = next;
  const attempted = { ...library.attempted, [band]: new Date(at).toISOString() };
  const pending = library.candidates.find(candidate => candidate.band_c === band);
  if (pending) {
    const result = comparison(rows, library.active, pending, reference);
    const candidates = library.candidates.filter(candidate => candidate !== pending);
    if (result.warming === "worse" || result.cooldown === "worse") return { ...library, attempted, candidates };
    if (result.warming === "better" && result.cooldownHeld) {
      return { ...library, attempted, candidates, active: [...library.active.filter(point => point.band_c !== band), pending]
        .sort((a, b) => a.band_c - b.band_c) };
    }
    return { ...library, attempted };
  }
  const training = history ? rows.filter(row => row.start_ms < history.split) : rows;
  const fit = fitRoomBand(training, reference, outdoor => heatingBand(outdoor) === band, ratedPowerW);
  const incumbent = library.active.find(point => point.band_c === band);
  if (!fit || (incumbent && (fit.minC > incumbent.observed_min_c || fit.maxC < incumbent.observed_max_c))) {
    return { ...library, attempted };
  }
  const candidate: RoomHeatingBand = {
    revision: crypto.randomUUID(), band_c: band, observed_min_c: fit.minC, observed_max_c: fit.maxC,
    training_from: new Date(training[0].start_ms).toISOString(),
    training_to: new Date(training.at(-1)!.start_ms + QUARTER_MS).toISOString(),
    model: fit.model,
  };
  if (history) {
    const result = comparison(rows, library.active, candidate, reference);
    if (result.warming === "better" && result.cooldownHeld) return { ...library, attempted,
      active: [...library.active.filter(point => point.band_c !== band), candidate].sort((a, b) => a.band_c - b.band_c) };
    if (result.warming === "worse" || result.cooldown === "worse") return { ...library, attempted };
  }
  return { ...library, attempted, candidates: [...library.candidates, candidate] };
}
