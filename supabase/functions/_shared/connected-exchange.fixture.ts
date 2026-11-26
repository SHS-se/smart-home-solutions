import type { ConnectedRoomResponse } from "./planner/models/room/connected-exchange.ts";
import type { RoomMeanQuarter } from "./device-learning/room/mean-observations.ts";

/** Independently generated synthetic plant: fine Euler integration, not the fitted observation kernel. */
export function syntheticConnectedPlant(changing: boolean, duration: 900 | 3600 = 900) {
  const rows: RoomMeanQuarter[] = []; let t = 19;
  for (let i = 0; i < 8 * 86400 / duration; i++) {
    const at = i * duration, outdoor = 5 + 4 * Math.sin(at / 86400), peer = 23 + 2 * Math.sin(at / 23000);
    const rate = changing && at >= 4 * 86400 ? .7 : .1;
    let sum = 0;
    for (let second = 0; second < duration; second++) { sum += t; t += (.04 * (outdoor - t) + rate * (peer - t)) / 3600; }
    rows.push({ start_ms: at * 1000, duration_s: duration, room_c: sum / duration, outdoor_c: outdoor,
      house_c: null, heat_w: null, solar_w_per_m2: null, cooling: null, peer_c: { peer } });
  }
  return rows;
}
export function syntheticConnectedResponse(adaptive = true): ConnectedRoomResponse {
  const n = adaptive ? 3 : 2;
  return { family: "adaptive_connected_native_v1", thermal: { outdoor_per_h: .04, heater: null, solar_per_wm2_h: 0, background_per_h: 0 },
    incoming: [adaptive ? { kind: "log_ou", from: "peer", mean_log_per_h: Math.log(.1), reversion_per_h: 1 / 72, stationary_variance: 2 }
      : { kind: "constant", from: "peer", per_h: .1 }], observation_noise_c2_h: .0001, thermal_noise_c2_per_h: .00001,
    reference_state: { through_ms: 0, temperature_c: 19, stored_heat_c: 0, log_rates: adaptive ? [Math.log(.1)] : [],
      covariance: Array.from({ length: n }, () => Array<number>(n).fill(0)), observations: 0 },
    basis: { graph_owner: "synthetic", graph_revision: 1, topology_hash: "synthetic", source_policy: "synthetic", source_revision: 1,
      history_from: new Date(0).toISOString(), history_to: new Date(8 * 86400_000).toISOString() }, evidence: {} };
}

/** Independent two-room plant with changing effective exchange, metered random
 * heating, receiver storage and noisy interval means. No production data. */
export function syntheticConnectedNetwork(days: number, persistenceHours: number, noiseC = .025) {
  let rng = 71239;
  const uniform = () => { rng = (Math.imul(rng, 1664525) + 1013904223) >>> 0; return (rng + .5) / 4294967296; };
  const normal = () => Math.sqrt(-2 * Math.log(uniform())) * Math.cos(2 * Math.PI * uniform());
  let a = 19, b = 23, heat = 0, logRate = Math.log(.2), weather = 5;
  const rows: RoomMeanQuarter[] = [], peerRows: RoomMeanQuarter[] = [], rates: number[] = [];
  const h = .25, rho = Math.exp(-h / persistenceHours), variance = .65;
  for (let i = 0; i < days * 96; i++) {
    logRate = Math.log(.2) + rho * (logRate - Math.log(.2)) + Math.sqrt(variance * (1 - rho * rho)) * normal();
    const rate = Math.exp(logRate), power = uniform() < .4 ? 850 : 0, otherPower = uniform() < .5 ? 1000 : 0;
    weather = .995 * weather + .005 * 5 + .2 * normal();
    let sumA = 0, sumB = 0;
    // Midpoint integration independently advances both rooms from the same state.
    const derivative = (x: number, y: number, q: number) => [
      .04 * (weather - x) + rate * (y - x) + q,
      .055 * (weather - y) + .7 * rate * (x - y) + .0012 * otherPower,
      .001 * power - q,
    ];
    const dt = 5 / 3600;
    for (let second = 0; second < 900; second += 5) {
      const d = derivative(a, b, heat), mid = [a + d[0] * dt / 2, b + d[1] * dt / 2, heat + d[2] * dt / 2];
      const next = derivative(mid[0], mid[1], mid[2]);
      sumA += mid[0]; sumB += mid[1]; a += next[0] * dt; b += next[1] * dt; heat += next[2] * dt;
    }
    const meanA = sumA / 180 + noiseC * normal(), meanB = sumB / 180 + noiseC * normal();
    rows.push({ start_ms: i * 900_000, duration_s: 900, room_c: meanA, outdoor_c: weather, house_c: null,
      heat_w: power, cooling: false, solar_w_per_m2: null, peer_c: { peer: meanB } });
    peerRows.push({ start_ms: i * 900_000, duration_s: 900, room_c: meanB, outdoor_c: weather, house_c: null,
      heat_w: otherPower, cooling: false, solar_w_per_m2: null, peer_c: { receiver: meanA } });
    rates.push(rate);
  }
  return { rows, peerRows, rates };
}
