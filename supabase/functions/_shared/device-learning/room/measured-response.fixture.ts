/** Independently generated synthetic data. No household observations. */
import type { RoomMeanQuarter } from "./mean-observations.ts";
import { roomResponseTrainingLength } from "./chronological-evidence.ts";
export function syntheticMeasuredRoom(count = 360, weatherSlope = .025, lag = 1, duration: 900 | 3600 = 900, solarGain = 0) {
  const rows: RoomMeanQuarter[] = [];
  let temperature = 20, stored = .7;
  const reference = 5, gain = .002, outdoorK = .035, houseK = .025, background = .03;
  for (let i = 0; i < count; i++) {
    const outdoor = 5 + 9 * Math.sin(i / 29), house = 20 + Math.sin(i / 13);
    const power = i % 37 >= 3 && i % 37 <= 14 ? 450 + 90 * Math.sin(i / 7) : 0;
    const solar = Math.max(0, 350 * Math.sin(i * Math.PI / 48));
    const input = gain * Math.max(0, 1 + weatherSlope * (outdoor - reference)) * power;
    const rate = (t: number, q: number) => [outdoorK * (outdoor - t) + houseK * (house - t) + background + solarGain * solar + (lag ? q / lag : input), lag ? input - q / lag : 0];
    const steps = 100, dt = duration / 3600 / steps;
    let integral = 0;
    for (let j = 0; j < steps; j++) {
      const a = rate(temperature, stored), b = rate(temperature + a[0] * dt / 2, stored + a[1] * dt / 2);
      const c = rate(temperature + b[0] * dt / 2, stored + b[1] * dt / 2), d = rate(temperature + c[0] * dt, stored + c[1] * dt);
      const next = temperature + dt * (a[0] + 2 * b[0] + 2 * c[0] + d[0]) / 6;
      integral += (temperature + next) * dt / 2;
      temperature = next; stored += dt * (a[1] + 2 * b[1] + 2 * c[1] + d[1]) / 6;
    }
    rows.push({ start_ms: Date.UTC(2025, 0, 1) + i * duration * 1000, duration_s: duration,
      room_c: integral / (duration / 3600), outdoor_c: outdoor, house_c: house,
      heat_w: power, solar_w_per_m2: solarGain > 0 ? solar : null, cooling: false });
  }
  return { rows, gain, reference, weatherSlope, lag, outdoorK, houseK, background };
}
export function measuredSyntheticEvidence(rows: RoomMeanQuarter[]) {
  return { fullRows: rows, trainingRows: rows.slice(0, roomResponseTrainingLength(rows.map(row => row.duration_s ?? 900))) };
}
