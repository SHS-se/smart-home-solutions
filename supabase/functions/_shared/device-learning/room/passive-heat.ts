// A monitored appliance is an observed heat source. Its watts are never an actuator.
import { HEATED_SAMPLE_MIN_W } from "./regression.ts";
import { fitRoomMeans, roomMeanHeat, roomMeanObservation, type RoomMeanFitResult, type RoomMeanQuarter } from "./mean-observations.ts";
import { SLOT_HOURS, type PassiveRoomHeat, type ThermalZoneModel } from "../../planner/models/room/thermal.ts";

const QUARTER_MS = SLOT_HOURS * 3_600_000;
const COOLDOWN_QUARTERS = 12;
const LAGS_H = [0.0625, 0.125, 0.25, 0.5, 0.75, 1, 1.5, 2];

type Cycle = { start: number; stop: number; end: number };
type Sample = { direct: number; delayed: number; residual: number; running: boolean };
type Gain = { direct: number; delayed: number };
export type PassiveHeatScores = { cycles: number; running: { baseline: number; fitted: number }; cooldown: { baseline: number; fitted: number } };

function observedCycles(rows: readonly RoomMeanQuarter[], watts: ReadonlyMap<number, number>): Cycle[] {
  const cycles: Cycle[] = [];
  const measured = (i: number) => i >= 0 && i < rows.length &&
    watts.has(rows[i].start_ms) && (i === 0 || rows[i].start_ms - rows[i - 1].start_ms === QUARTER_MS);
  const active = (i: number) => (watts.get(rows[i]?.start_ms) ?? 0) > HEATED_SAMPLE_MIN_W;
  for (let i = 1; i < rows.length; i++) {
    if (!active(i) || active(i - 1) || !measured(i - 1) || !measured(i)) continue;
    const start = i;
    let stop = i + 1;
    while (measured(stop) && active(stop)) stop++;
    const end = stop + COOLDOWN_QUARTERS;
    if (!Array.from({ length: COOLDOWN_QUARTERS + 1 }, (_, j) => measured(stop + j) && !active(stop + j)).every(Boolean)) {
      i = stop - 1;
      continue;
    }
    // A later run inside another run's cooldown cannot validate that cooldown.
    if (start >= (cycles.at(-1)?.end ?? 0)) cycles.push({ start, stop, end });
    i = end - 1;
  }
  return cycles;
}

function cycleSamples(
  rows: readonly RoomMeanQuarter[], watts: ReadonlyMap<number, number>, cycles: Cycle[],
  model: ThermalZoneModel, lag: number,
): Sample[][] {
  const k = model.cooling_constant_per_h + (model.house_coupling_per_h ?? 0);
  const floor = roomMeanObservation(k, model.heat_lag_h ?? 0);
  const passive = roomMeanObservation(k, lag);
  const { a, E, V, effect } = floor;
  const L = E * effect - a * V;
  const forcing = (q: RoomMeanQuarter) => model.background_gain_c_per_h +
    model.cooling_constant_per_h * q.outdoor_c! + (model.house_coupling_per_h ?? 0) * q.house_c! +
    (model.solar_gain_c_per_h_per_wm2 ?? 0) * (q.solar_w_per_m2 ?? model.solar_mean_w_per_m2 ?? 0);
  const result = cycles.map((): Sample[] => []);
  let floorMemory = 0, passiveMemory = 0, cycleIndex = 0;
  for (let i = 0; i + 1 < rows.length && cycleIndex < cycles.length; i++) {
    const q = rows[i], next = rows[i + 1], cycle = cycles[cycleIndex];
    const power = watts.get(q.start_ms), nextPower = watts.get(next.start_ms);
    const contiguous = next.start_ms - q.start_ms === QUARTER_MS;
    if (i >= cycle.start - 1 && contiguous && power !== undefined && nextPower !== undefined &&
      [q, next].every(r => !r.cooling && r.room_c !== null && r.outdoor_c !== null && r.house_c !== null && r.heat_w !== null)) {
      const residual = next.room_c! - a * q.room_c! - L * forcing(q) - V * forcing(next) -
        model.gain_c_per_wh * roomMeanHeat(floor, floorMemory, q.heat_w!, next.heat_w!);
      result[cycleIndex].push({ direct: L * power + V * nextPower,
        delayed: roomMeanHeat(passive, passiveMemory, power, nextPower), residual, running: i < cycle.stop });
    }
    if (i + 1 >= cycle.end) cycleIndex++;
    floorMemory = contiguous && q.heat_w !== null && !q.cooling ? floor.C * floorMemory + (1 - floor.C) * q.heat_w : 0;
    passiveMemory = contiguous && power !== undefined ? passive.C * passiveMemory + (1 - passive.C) * power : 0;
  }
  return result.filter(cycle => cycle.some(s => s.running) && cycle.some(s => !s.running));
}

/** Two nonnegative gains, with the zero-gain faces included in the solve. */
function fitGains(samples: readonly Sample[]): Gain {
  let dd = 0, dl = 0, ll = 0, dy = 0, ly = 0;
  for (const { direct, delayed, residual } of samples) {
    dd += direct * direct; dl += direct * delayed; ll += delayed * delayed;
    dy += direct * residual; ly += delayed * residual;
  }
  const determinant = dd * ll - dl * dl;
  const candidates = [
    { direct: dd > 0 ? Math.max(0, dy / dd) : 0, delayed: 0 },
    { direct: 0, delayed: ll > 0 ? Math.max(0, ly / ll) : 0 },
  ];
  if (determinant > Number.EPSILON * dd * ll) {
    const direct = (ll * dy - dl * ly) / determinant, delayed = (dd * ly - dl * dy) / determinant;
    if (direct >= 0 && delayed >= 0) candidates.push({ direct, delayed });
  }
  const error = ({ direct: d, delayed: l }: Gain) => dd * d * d + 2 * dl * d * l + ll * l * l - 2 * (dy * d + ly * l);
  return candidates.reduce((best, gain) => error(gain) < error(best) ? gain : best);
}

type Candidate = { lag: number; cycles: Sample[][] };
type ErrorSum = { baseline: number; fitted: number; count: number };
type PhaseErrors = { running: ErrorSum; cooldown: ErrorSum };

function score(samples: readonly Sample[], gain: Gain, errors: PhaseErrors) {
  for (const { direct, delayed, residual, running } of samples) {
    const phase = running ? errors.running : errors.cooldown;
    phase.count++;
    phase.baseline += residual ** 2;
    phase.fitted += (residual - direct * gain.direct - delayed * gain.delayed) ** 2;
  }
}

const emptyScores = (): PhaseErrors => ({
  running: { baseline: 0, fitted: 0, count: 0 },
  cooldown: { baseline: 0, fitted: 0, count: 0 },
});

function bestResponse(candidates: Candidate[], heldOut: number) {
  let best: { gain: Gain; candidate: Candidate; error: number } | undefined;
  for (const candidate of candidates) {
    const training = candidate.cycles.flatMap((cycle, i) => i === heldOut ? [] : cycle);
    const gain = fitGains(training);
    if (gain.delayed === 0) continue;
    const errors = emptyScores();
    score(training, gain, errors);
    // Score both phases relative to the ordinary room's own error. Running
    // changes are larger and otherwise swamp the slower cooldown signal.
    const error = Object.values(errors).reduce((sum, phase) =>
      sum + (phase.baseline > 0 ? phase.fitted / phase.baseline : 0), 0);
    if (!best || error < best.error) best = { gain, candidate, error };
  }
  return best;
}

function heldOutScores(candidates: Candidate[], cycles: number): PassiveHeatScores | undefined {
  const errors = emptyScores();
  for (let i = 0; i < cycles; i++) {
    const best = bestResponse(candidates, i);
    if (!best) return;
    score(best.candidate.cycles[i], best.gain, errors);
  }
  const rmse = ({ baseline, fitted, count }: ErrorSum) =>
    ({ baseline: Math.sqrt(baseline / count), fitted: Math.sqrt(fitted / count) });
  return { cycles, running: rmse(errors.running), cooldown: rmse(errors.cooldown) };
}

export function fitRoomWithPassiveHeat(
  quarters: RoomMeanQuarter[], ratedPowerW: number | null,
  source: { device_key: string; watts: ReadonlyMap<number, number> },
): { room: RoomMeanFitResult; passive?: PassiveRoomHeat; scores?: PassiveHeatScores } {
  const rows = [...quarters].sort((a, b) => a.start_ms - b.start_ms);
  const cycles = observedCycles(rows, source.watts);
  const ordinary = { room: fitRoomMeans(rows, ratedPowerW) };
  if (!ordinary.room.ok || cycles.length < 2) return ordinary;

  // Exclude all the cycle temperatures from the common validation baseline.
  // The appliance fit is separate and cannot recalibrate the floor heater.
  const excluded = new Set(cycles.flatMap(({ start, end }) =>
    Array.from({ length: end - start + 1 }, (_, i) => start + i)));
  const quiet = fitRoomMeans(rows.map((q, i) => excluded.has(i) ? { ...q, room_c: null } : q), ratedPowerW);
  if (!quiet.ok) return ordinary;

  const candidates = LAGS_H.map(lag => ({ lag, cycles: cycleSamples(rows, source.watts, cycles, quiet.model, lag) }));
  const count = candidates[0].cycles.length;
  if (count < 2) return ordinary;
  const scores = heldOutScores(candidates, count);
  if (!scores || !(scores.running.fitted < scores.running.baseline && scores.cooldown.fitted < scores.cooldown.baseline)) {
    return { ...ordinary, scores };
  }
  const selected = bestResponse(candidates, -1);
  if (!selected) return { ...ordinary, scores };
  const { gain, candidate } = selected;
  return { ...ordinary, passive: { device_key: source.device_key, direct_c_per_wh: gain.direct,
    delayed_c_per_wh: gain.delayed, lag_h: candidate.lag }, scores };
}
