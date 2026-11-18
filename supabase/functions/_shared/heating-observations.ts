/** Native Recorder intervals for learning; never converted into quarter actuals. */
import type { ProbeEvidence } from "./device-learning/room/source-freshness.ts";

export interface HeatingProbeObservation {
  start: string;
  duration_s: 900 | 3600;
  probes: ProbeEvidence[];
}

/** Shared household facts are captured once, independently of heater count. */
export function parseHeatingProbeObservations(input: unknown, fromMs: number, toMs: number) {
  const observations: HeatingProbeObservation[] = [];
  const ignored: Record<string, number> = {};
  const skip = (reason: string) => { ignored[reason] = (ignored[reason] ?? 0) + 1; };
  if (!Array.isArray(input)) return { observations, ignored: { invalid_heating_probe_observations: 1 } };
  const seen = new Set<string>();
  for (const row of input) {
    if (!object(row)) { skip("invalid_heating_probe_observation"); continue; }
    const duration = row.duration_s;
    const start = typeof row.start === "string" ? Date.parse(row.start) : NaN;
    if ((duration !== 900 && duration !== 3600) || !Number.isFinite(start) || start % (duration * 1000) ||
      start < fromMs || start + duration * 1000 > toMs) { skip("invalid_heating_probe_interval"); continue; }
    if (!Array.isArray(row.probes) || !row.probes.length) { skip("invalid_heating_probe_evidence"); continue; }
    const sources = new Set<string>();
    const valid = row.probes.every(probe => {
      if (!object(probe) || typeof probe.source_key !== "string" || !/^[a-f0-9]{64}$/.test(probe.source_key) ||
        sources.has(probe.source_key) || typeof probe.area_key !== "string" || !probe.area_key ||
        !(probe.cohort_key === null ||
          typeof probe.cohort_key === "string" && /^[a-f0-9]{64}$/.test(probe.cohort_key)) ||
        ![probe.unchanged, probe.joint_unchanged, probe.reported, probe.unavailable].every(value =>
          value === null || typeof value === "boolean")) return false;
      sources.add(probe.source_key);
      return true;
    });
    if (!valid) { skip("invalid_heating_probe_evidence"); continue; }
    const key = `${start}:${duration}`;
    if (seen.has(key)) { skip("duplicate_heating_probe_interval"); continue; }
    seen.add(key);
    observations.push({ start: new Date(start).toISOString(), duration_s: duration,
      probes: row.probes.map(probe => {
        // A sensor's invalid scalar must not block every room's history ACK.
        // Keep the interval and source identity, but never turn it into a
        // usable temperature or evidence that the sensor was unchanged.
        const validMean = temperature(probe.mean);
        if (!validMean) skip("invalid_heating_reading");
        return { source_key: probe.source_key, area_key: probe.area_key,
          mean: validMean && finite(probe.mean) ? probe.mean : null,
          unchanged: validMean ? probe.unchanged : null, joint_unchanged: validMean ? probe.joint_unchanged : null,
          cohort_key: probe.cohort_key, reported: probe.reported, unavailable: probe.unavailable };
      }) });
  }
  return { observations, ignored };
}

export interface HeatingObservation {
  room_key: string;
  source_key: string;
  start: string;
  duration_s: 900 | 3600;
  source: "recorder_5minute_mean" | "recorder_hour_mean";
  room_temperature_c: number | null;
  outdoor_temperature_c: number | null;
  house_temperature_c: number | null;
  solar_w_per_m2: number | null;
  device_statistics: Record<string, string>;
  device_energy_kwh: Record<string, number | null>;
  cooling: boolean | null;
  invalidated_device_keys?: string[];
  heater_energy_limits_w?: Record<string, number>;
}

const object = (value: unknown): value is Record<string, unknown> =>
  !!value && typeof value === "object" && !Array.isArray(value);
const finite = (value: unknown): value is number => typeof value === "number" && Number.isFinite(value);
const temperature = (value: unknown) => value == null || (finite(value) && value >= -50 && value <= 80);

/** Isolate malformed rows. Missing inputs remain explicitly unobserved. */
export function parseHeatingObservations(input: unknown, fromMs: number, toMs: number) {
  const observations: HeatingObservation[] = [];
  const ignored: Record<string, number> = {};
  const skip = (reason: string) => { ignored[reason] = (ignored[reason] ?? 0) + 1; };
  if (!Array.isArray(input)) return { observations, ignored: { invalid_heating_observations: 1 } };
  const seen = new Set<string>();
  for (const row of input) {
    if (!object(row)) { skip("invalid_heating_observation"); continue; }
    const duration = row.duration_s;
    const start = typeof row.start === "string" ? Date.parse(row.start) : NaN;
    if ((duration !== 900 && duration !== 3600) || !Number.isFinite(start) || start % (duration * 1000) ||
      start < fromMs || start + duration * 1000 > toMs) { skip("invalid_heating_interval"); continue; }
    if (typeof row.room_key !== "string" || !row.room_key || typeof row.source_key !== "string" ||
      !/^[a-f0-9]{64}$/.test(row.source_key) || row.source !== (duration === 900 ? "recorder_5minute_mean" : "recorder_hour_mean")) {
      skip("invalid_heating_source"); continue;
    }
    const reading = (value: unknown, valid: boolean): number | null => {
      if (!valid) skip("invalid_heating_reading");
      return valid && finite(value) ? value : null;
    };
    const roomTemperature = reading(row.room_temperature_c, temperature(row.room_temperature_c));
    const outdoorTemperature = reading(row.outdoor_temperature_c, temperature(row.outdoor_temperature_c));
    const houseTemperature = reading(row.house_temperature_c, temperature(row.house_temperature_c));
    const solar = reading(row.solar_w_per_m2,
      row.solar_w_per_m2 == null || (finite(row.solar_w_per_m2) && row.solar_w_per_m2 >= 0));
    const cooling = typeof row.cooling === "boolean" ? row.cooling : null;
    if (row.cooling != null && cooling === null) skip("invalid_heating_reading");
    if (!object(row.device_statistics) || !object(row.device_energy_kwh) || !Object.keys(row.device_statistics).length ||
      !Object.values(row.device_statistics).every(id => typeof id === "string" && id.length > 0) ||
      Object.entries(row.device_energy_kwh).some(([key, value]) => !Object.hasOwn(row.device_statistics as Record<string, unknown>, key) ||
        !(value === null || (finite(value) && value >= 0)))) { skip("invalid_heating_meter"); continue; }
    if (row.invalidated_device_keys !== undefined && (!Array.isArray(row.invalidated_device_keys) ||
      !row.invalidated_device_keys.every(key => typeof key === "string" && Object.hasOwn(row.device_statistics as Record<string, unknown>, key)))) {
      skip("invalid_heating_retraction"); continue;
    }
    if (row.heater_energy_limits_w !== undefined && (!object(row.heater_energy_limits_w) ||
      Object.entries(row.heater_energy_limits_w).some(([key, value]) =>
        !Object.hasOwn(row.device_statistics as Record<string, unknown>, key) || !finite(value) || value <= 0))) {
      skip("invalid_heater_attribution"); continue;
    }
    const key = JSON.stringify([row.room_key, row.source_key, start, duration,
      Object.entries(row.device_statistics).sort(([a], [b]) => a.localeCompare(b))]);
    if (seen.has(key)) { skip("duplicate_heating_interval"); continue; }
    seen.add(key);
    observations.push({ room_key: row.room_key, source_key: row.source_key, start: new Date(start).toISOString(),
      duration_s: duration, source: duration === 900 ? "recorder_5minute_mean" : "recorder_hour_mean",
      room_temperature_c: roomTemperature,
      outdoor_temperature_c: outdoorTemperature,
      house_temperature_c: houseTemperature,
      solar_w_per_m2: solar,
      device_statistics: row.device_statistics as Record<string, string>,
      device_energy_kwh: row.device_energy_kwh as Record<string, number | null>,
      cooling: cooling,
      ...(row.heater_energy_limits_w === undefined ? {} : { heater_energy_limits_w: row.heater_energy_limits_w as Record<string, number> }),
      ...(row.invalidated_device_keys === undefined ? {} : { invalidated_device_keys: row.invalidated_device_keys as string[] }) });
  }
  return { observations, ignored };
}
