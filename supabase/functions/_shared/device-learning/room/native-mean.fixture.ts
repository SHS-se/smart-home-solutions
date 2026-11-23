import { roomResponseTrainingLength } from "./response-learning.ts";
import type { RoomMeanQuarter } from "./mean-observations.ts";

const defaultProfile = {
  gain: .0015, houseGain: .02, outdoorGain: .03, background: .02, roomStart: 20, startMs: Date.UTC(2025, 9, 1), steps: 300,
  forcing: (i: number, solarGain: number) => ({
    outdoor: -7 + .5 * Math.sin(i / 13), house: 21 + .2 * Math.cos(i / 19), watts: i % 11 < 3 ? 500 : 0,
    solar: solarGain ? Math.max(0, 500 * Math.sin(i / 5)) : null,
  }),
};

/** Independently generated synthetic room: RK4 integrates the differential
 * equations and their interval means. It never calls the production kernel. */
export function syntheticRoomPlant(durations: (900 | 3600)[], count = 240, lag = 1, solarGain = 0,
  profile: typeof defaultProfile & { dynamics?: (index: number) => { gain: number; houseGain: number; outdoorGain: number; background: number } } = defaultProfile) {
  const { gain, houseGain, outdoorGain, background, steps } = profile;
  let temperature = profile.roomStart, delivered = 0, time = profile.startMs;
  const memory: number[] = [], rows: RoomMeanQuarter[] = [];
  for (let i = 0; i < count; i++) {
    const duration = durations[i % durations.length], hours = duration / 3600;
    const { outdoor, house, watts, solar } = profile.forcing(i, solarGain);
    memory.push(delivered);
    const dynamics = profile.dynamics?.(i) ?? { gain, houseGain, outdoorGain, background };
    const rate = (t: number, d: number) => [dynamics.gain * (lag > 0 ? d : watts) + dynamics.houseGain * (house - t) + dynamics.outdoorGain * (outdoor - t) + dynamics.background + solarGain * (solar ?? 0),
      lag > 0 ? (watts - d) / lag : 0];
    const dt = hours / steps;
    let integral = 0;
    for (let step = 0; step < steps; step++) {
      const a = rate(temperature, delivered), b = rate(temperature + a[0] * dt / 2, delivered + a[1] * dt / 2);
      const c = rate(temperature + b[0] * dt / 2, delivered + b[1] * dt / 2), d = rate(temperature + c[0] * dt, delivered + c[1] * dt);
      const next = temperature + dt * (a[0] + 2 * b[0] + 2 * c[0] + d[0]) / 6;
      integral += (temperature + next) / 2;
      temperature = next; delivered += dt * (a[1] + 2 * b[1] + 2 * c[1] + d[1]) / 6;
    }
    rows.push({ start_ms: time, duration_s: duration, room_c: integral / steps, house_c: house, outdoor_c: outdoor,
      heat_w: watts, solar_w_per_m2: solar, cooling: false });
    time += duration * 1000;
  }
  return { rows, memory, gain, houseGain, outdoorGain, lag, background };
}

/** A maximum-window control with independent weather, metered heat and solar.
 * Unknown meter observations fracture recorded episodes while the plant runs. */
export function syntheticRoomBandStress(fragmented = true): RoomMeanQuarter[] {
  const { rows } = syntheticRoomPlant([900], 400 * 96, 0, .003, {
    gain: .002, houseGain: .03, outdoorGain: .05, background: .03, roomStart: 15.5, startMs: Date.UTC(2025, 0, 1), steps: 15,
    forcing: i => ({
      outdoor: -7 + 1.1 * Math.sin(i / 85), house: 21 + .2 * Math.cos(i / 39),
      watts: i % 43 < 15 ? 800 : i % 73 < 11 ? 500 : 0,
      solar: Math.max(0, 330 * Math.sin(i / 96 * 2 * Math.PI)),
    }),
  });
  if (fragmented) for (let i = 95; i < rows.length; i += 96) rows[i].heat_w = null;
  return rows;
}

/** Synthetic inputs have no read-time probe inference. Training and full
 * observe the same source-qualified values at their common timestamps. */
export function syntheticRoomResponseEvidence(rows: RoomMeanQuarter[]) {
  return { fullRows: rows, trainingRows: rows.slice(0, roomResponseTrainingLength(rows.map(row => row.duration_s ?? 900))) };
}
