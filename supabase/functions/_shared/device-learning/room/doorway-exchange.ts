import {
  roomMeanHeat,
  roomMeanObservation,
  type RoomMeanQuarter,
} from "./mean-observations.ts";
import type { ThermalZoneModel } from "../../planner/models/room/thermal.ts";
import { ROOM_QUARTER_MS as Q } from "./doorway-shadow.ts";
const finite = (x: unknown): x is number =>
  typeof x === "number" && Number.isFinite(x);
export interface DoorwayProbe {
  key: string;
  source: string;
  observed: ReadonlyMap<number, number>;
}
export interface DoorwayResponse {
  key: string;
  source: string;
  weight: number;
  usual: number;
  persistence: number;
}
const dot = (a: number[], b: number[]) =>
  a.reduce((sum, v, i) => sum + v * b[i], 0);
const clip = (x: number, max: number) => Math.max(0, Math.min(x, max));
export function learnDoorwayExchange(
  rows: RoomMeanQuarter[],
  inputs: DoorwayProbe[],
  model: ThermalZoneModel,
): DoorwayResponse[] {
  const indoor = model.house_coupling_per_h ?? 0;
  if (!(indoor > 0) || !inputs.length) return [];
  const outdoor = model.cooling_constant_per_h;
  const sun = model.solar_gain_c_per_h_per_wm2 ?? 0;
  const op = roomMeanObservation(outdoor + indoor, model.heat_lag_h ?? 0);
  const { a, effect, E, V, C } = op;
  const L = E * effect - a * V;
  const peers = inputs.flatMap((peer) => {
    const points = rows.flatMap((q) => {
      const near = peer.observed.get(q.start_ms);
      return finite(q.house_c) && finite(near)
        ? [{ t: q.start_ms, delta: near - q.house_c }]
        : [];
    });
    if (!points.length) return [];
    const usual = points.reduce((sum, q) => sum + q.delta, 0) / points.length;
    let bounds = 0, cross = 0;
    for (let i = 1; i < points.length; i++) {
      if (points[i].t - points[i - 1].t !== Q) continue;
      const previous = points[i - 1].delta - usual;
      bounds += previous * previous;
      cross += previous * (points[i].delta - usual);
    }
    return bounds > 0
      ? [{ ...peer, usual, persistence: clip(cross / bounds, 1) }]
      : [];
  });
  if (!peers.length) return [];
  const xtx = peers.map(() => peers.map(() => 0));
  const xty = peers.map(() => 0);
  const warm = Math.ceil((model.heat_lag_h ?? 0) * 4 * 5);
  let delivered = 0;
  let history = 0;
  const covered = (
    q: RoomMeanQuarter,
  ): q is
    & RoomMeanQuarter
    & Record<"room_c" | "outdoor_c" | "house_c" | "heat_w", number> =>
    !q.cooling && finite(q.room_c) && finite(q.outdoor_c) &&
    finite(q.house_c) && finite(q.heat_w) && (!sun || finite(q.solar_w_per_m2));
  for (let i = 0; i + 1 < rows.length; i++) {
    const q = rows[i], next = rows[i + 1];
    if (next.start_ms - q.start_ms !== Q || q.cooling || !finite(q.heat_w)) {
      delivered = history = 0;
      continue;
    }
    if (history >= warm && covered(q) && covered(next)) {
      const x = peers.map((peer) => {
        const first = peer.observed.get(q.start_ms),
          last = peer.observed.get(next.start_ms);
        // A missing peer does not provide information about that coefficient.
        return finite(first) && finite(last)
          ? L * (first - q.house_c - peer.usual) +
            V * (last - next.house_c - peer.usual)
          : 0;
      });
      const y = next.room_c - a * q.room_c -
        model.gain_c_per_wh *
          roomMeanHeat(op, delivered, q.heat_w, next.heat_w) -
        outdoor * (L * q.outdoor_c + V * next.outdoor_c) -
        indoor * (L * q.house_c + V * next.house_c) -
        sun * (L * (q.solar_w_per_m2 ?? 0) + V * (next.solar_w_per_m2 ?? 0)) -
        effect * model.background_gain_c_per_h;
      for (let j = 0; j < x.length; j++) {
        xty[j] += x[j] * y;
        for (let k = 0; k < x.length; k++) xtx[j][k] += x[j] * x[k];
      }
    }
    delivered = C * delivered + (1 - C) * q.heat_w;
    history++;
  }
  const lipschitz = Math.max(
    ...xtx.map((row) => row.reduce((sum, x) => sum + Math.abs(x), 0)),
  );
  if (!(lipschitz > 0)) return [];
  let weights = peers.map(() => 0);
  for (let iteration = 0; iteration < 256; iteration++) {
    const proposal = weights.map((w, j) =>
      Math.max(0, w + (xty[j] - dot(xtx[j], weights)) / lipschitz)
    );
    if (proposal.reduce((sum, w) => sum + w, 0) > indoor) {
      let sum = 0;
      const threshold = [...proposal].sort((a, b) => b - a).reduce(
        (current, w, i) => {
          sum += w;
          return Math.max(current, (sum - indoor) / (i + 1));
        },
        0,
      );
      for (let j = 0; j < proposal.length; j++) {
        proposal[j] = Math.max(0, proposal[j] - threshold);
      }
    }
    if (Math.max(...proposal.map((w, j) => Math.abs(w - weights[j]))) < 1e-9) {
      weights = proposal;
      break;
    }
    weights = proposal;
  }
  return peers.flatMap(({ key, source, usual, persistence }, i) =>
    weights[i] > 0
      ? [{ key, source, usual, persistence, weight: weights[i] }]
      : []
  );
}

/** Compare the incremental exchange on later, matched forecast origins.
 * Both candidates use the same receiving-room calibration, weather estimate
 * and last day's heater profile. A peer contributes only from observations
 * available at the origin. Cutoff is in days to preserve overnight cycles. */
export function selectDoorwayExchange(
  rows: RoomMeanQuarter[],
  peers: DoorwayProbe[],
  model: ThermalZoneModel,
): DoorwayResponse[] {
  if (!peers.length || !(model.house_coupling_per_h! > 0)) return [];
  const from = rows[0]?.start_ms, to = rows.at(-1)?.start_ms;
  if (from === undefined || to === undefined) return [];
  const day = Q * 96;
  const cutoff = Math.ceil((from + (to - from) * 2 / 3) / day) * day;
  const candidate = learnDoorwayExchange(
    rows.filter((row) => row.start_ms < cutoff),
    peers,
    model,
  );
  if (!candidate.length) return [];
  const index = new Map(rows.map((row) => [row.start_ms, row]));
  const probes = new Map(peers.map((peer) => [peer.key, peer.observed]));
  const indoor = model.house_coupling_per_h!;
  const { a, effect, E, V, C, B, U } = roomMeanObservation(
    indoor + model.cooling_constant_per_h,
    model.heat_lag_h ?? 0,
  );
  let plainError = 0, linkedError = 0;
  for (let t = cutoff; t + 23 * Q <= to; t += 12 * Q) {
    const start = index.get(t - Q);
    if (
      !start || start.cooling || !finite(start.room_c) ||
      !finite(start.house_c) || !finite(start.outdoor_c)
    ) continue;
    const forcing = model.background_gain_c_per_h + indoor * start.house_c +
      model.cooling_constant_per_h * start.outdoor_c;
    const starts = candidate.map((peer) => {
      const value = probes.get(peer.key)?.get(start.start_ms);
      return finite(value)
        ? peer.weight * (value - start.house_c! - peer.usual)
        : 0;
    });
    if (!starts.some(Boolean)) continue;
    let delivered = 0, room = start.room_c, change = 0;
    const heatGain = model.gain_c_per_wh;
    for (let j = t - day; j < t; j += Q) {
      const past = index.get(j)?.heat_w;
      if (finite(past)) delivered = C * delivered + (1 - C) * past;
    }
    for (let i = 0; i < 24; i++) {
      const future = index.get(t + i * Q);
      const yesterday = index.get(t + i * Q - day);
      if (
        !future || !yesterday || future.cooling || yesterday.cooling ||
        !finite(future.room_c) || !finite(yesterday.heat_w)
      ) break;
      const qForcing = forcing +
        (model.solar_gain_c_per_h_per_wm2 ?? 0) *
          (yesterday.solar_w_per_m2 ?? 0);
      const correction = candidate.reduce(
        (total, peer, j) => total + starts[j] * peer.persistence ** (i + 1),
        0,
      );
      const mean = E * room + V * qForcing +
        heatGain * (U * delivered + (V - U) * yesterday.heat_w);
      if (i === 3 || i === 11 || i === 23) {
        plainError += Math.abs(mean - future.room_c);
        linkedError += Math.abs(
          mean + E * change + V * correction - future.room_c,
        );
      }
      room = a * room + effect * qForcing +
        heatGain * (B * delivered + (effect - B) * yesterday.heat_w);
      change = a * change + effect * correction;
      delivered = C * delivered + (1 - C) * yesterday.heat_w;
    }
  }
  return linkedError < plainError
    ? learnDoorwayExchange(rows, peers, model)
    : [];
}
