/** Independently generated synthetic plants. No household observations or production kernels. */
import type { RoomMeanQuarter } from "./mean-observations.ts";

export interface SyntheticOperationOptions {
  count?: number;
  durations?: readonly (900 | 3600)[];
  standbyW?: number;
  outdoorK?: number;
  houseK?: number;
  background?: number;
  gain?: number;
  weatherSlope?: number;
  lagHours?: number;
  initialC?: number;
  outdoorC?: (hour: number) => number;
  houseC?: (hour: number) => number;
  watts?: (hour: number) => number;
  extraHeat?: (hour: number) => number;
}

/** Exact integration of the independently specified immediate plant. */
export function syntheticImmediateInterval(startC: number, hours: number, forcing: number, k: number) {
  if (k === 0) return { mean: startC + forcing * hours / 2, end: startC + forcing * hours };
  const equilibrium = forcing / k;
  return { mean: equilibrium + (startC - equilibrium) * -Math.expm1(-k * hours) / (k * hours),
    end: equilibrium + (startC - equilibrium) * Math.exp(-k * hours) };
}

export function syntheticOperationRoom(options: SyntheticOperationOptions = {}) {
  const outdoorK = options.outdoorK ?? .025, houseK = options.houseK ?? .08;
  const gain = options.gain ?? .002, reference = 5, weatherSlope = options.weatherSlope ?? .02;
  const background = options.background ?? .02, lag = options.lagHours ?? 0;
  const rows: RoomMeanQuarter[] = [], durations = options.durations ?? [900];
  let temperature = options.initialC ?? 22, stored = 0, hour = 0;
  for (let i = 0; i < (options.count ?? 960); i++) {
    const seconds = durations[i % durations.length], hours = seconds / 3600;
    const outdoor = options.outdoorC?.(hour) ?? 5 + 7 * Math.sin(hour / 29);
    const house = options.houseC?.(hour) ?? 20 + 1.3 * Math.sin(hour / 11);
    const phase = hour % 24;
    const power = options.watts?.(hour) ?? (phase < .5 ? 600 : phase >= 12 && phase < 14 ? 450 : options.standbyW ?? 0);
    const input = gain * (1 + weatherSlope * (outdoor - reference)) * power;
    const forcing = outdoorK * outdoor + houseK * house + background + (options.extraHeat?.(hour) ?? 0);
    let mean: number;
    if (!lag) {
      const step = syntheticImmediateInterval(temperature, hours, forcing + input, outdoorK + houseK);
      mean = step.mean; temperature = step.end;
    } else {
      // Independent RK4 integrates temperature, stored heat and the temperature integral.
      const rate = (t: number, q: number) => [-(outdoorK + houseK) * t + forcing + q / lag, input - q / lag, t];
      let integral = 0;
      const count = 120, dt = hours / count;
      for (let step = 0; step < count; step++) {
        const a = rate(temperature, stored);
        const b = rate(temperature + a[0] * dt / 2, stored + a[1] * dt / 2);
        const c = rate(temperature + b[0] * dt / 2, stored + b[1] * dt / 2);
        const d = rate(temperature + c[0] * dt, stored + c[1] * dt);
        temperature += dt * (a[0] + 2 * b[0] + 2 * c[0] + d[0]) / 6;
        stored += dt * (a[1] + 2 * b[1] + 2 * c[1] + d[1]) / 6;
        integral += dt * (a[2] + 2 * b[2] + 2 * c[2] + d[2]) / 6;
      }
      mean = integral / hours;
    }
    rows.push({ start_ms: Date.UTC(2001, 0, 1) + hour * 3_600_000, duration_s: seconds,
      room_c: mean, outdoor_c: outdoor, house_c: house, heat_w: power, cooling: false, solar_w_per_m2: null });
    hour += hours;
  }
  return { rows, outdoorK, houseK, gain, reference, weatherSlope, background, lag };
}
