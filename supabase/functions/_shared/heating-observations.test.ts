import { assertEquals } from "jsr:@std/assert@1";
import { parseHeatingObservations, parseHeatingProbeObservations } from "./heating-observations.ts";

// Independently generated synthetic transport records, no household captures.
const start = Date.UTC(2025, 0, 1);
const row = { room_key: "room", source_key: "a".repeat(64), start: new Date(start).toISOString(),
  duration_s: 3600, source: "recorder_hour_mean", room_temperature_c: 20, outdoor_temperature_c: -12,
  house_temperature_c: 19, solar_w_per_m2: null, device_statistics: { heater: "sensor.energy" },
  device_energy_kwh: { heater: .4 }, cooling: false };

Deno.test("probe evidence preserves unknown reporting facts and rejects ambiguous source identities", () => {
  const probe = { source_key: "a".repeat(64), area_key: "room", mean: 20,
    unchanged: true, joint_unchanged: null, cohort_key: null, reported: null, unavailable: null };
  const observation = { start: row.start, duration_s: 3600 as const, probes: [probe] };
  const parsed = parseHeatingProbeObservations([observation,
    { ...observation, probes: [probe, probe] },
    { ...observation, probes: [{ ...probe, joint_unchanged: "yes" }] },
    { ...observation, start: new Date(start + 900_000).toISOString() },
    { ...observation, probes: [{ ...probe, cohort_key: "guessed sensor name" }] },
  ], start, start + 3_600_000);
  assertEquals(parsed.observations, [observation]);
  assertEquals(parsed.ignored, { invalid_heating_probe_evidence: 3, invalid_heating_probe_interval: 1 });
  // Auxiliary validation is independent of real energy acceptance.
  assertEquals(parseHeatingObservations([row], start, start + 3_600_000).observations[0].device_energy_kwh, { heater: .4 });
});

Deno.test("a probe scalar glitch cannot stall shared household history acknowledgement", () => {
  const probe = { source_key: "a".repeat(64), area_key: "room", mean: 85,
    unchanged: true, joint_unchanged: true, cohort_key: null, reported: null, unavailable: null };
  const result = parseHeatingProbeObservations([{ start: row.start, duration_s: 3600,
    probes: [probe, { ...probe, source_key: "b".repeat(64), area_key: "peer", mean: 20 }] }], start, start + 3_600_000);
  assertEquals(result.observations.length, 1);
  assertEquals(result.observations[0].probes[0], { ...probe, mean: null, unchanged: null, joint_unchanged: null });
  assertEquals(result.observations[0].probes[1].mean, 20);
  assertEquals(result.ignored, { invalid_heating_reading: 1 });
});

Deno.test("native heating retains one real hour and negative outdoor temperatures", () => {
  const result = parseHeatingObservations([row], start, start + 3_600_000);
  assertEquals(result.ignored, {});
  assertEquals(result.observations.length, 1);
  assertEquals(result.observations[0].duration_s, 3600);
  assertEquals(result.observations[0].outdoor_temperature_c, -12);
  assertEquals(result.observations[0].device_energy_kwh.heater, .4);
});
Deno.test("unavailable heater and cooling activity stay unknown, not measured OFF", () => {
  const result = parseHeatingObservations([{ ...row, device_energy_kwh: { heater: null }, cooling: null }], start, start + 3_600_000);
  assertEquals(result.observations[0].device_energy_kwh.heater, null);
  assertEquals(result.observations[0].cooling, null);
});
Deno.test("invalid source rows cannot discard usable heating evidence", () => {
  const result = parseHeatingObservations([
    { ...row, start: new Date(start + 900_000).toISOString() },
    { ...row, device_energy_kwh: { other: 1 } },
    { ...row, source: "recorder_5minute_mean" }, row, row,
  ], start, start + 7_200_000);
  assertEquals(result.observations.length, 1);
  assertEquals(result.ignored, { invalid_heating_interval: 1, invalid_heating_meter: 1,
    invalid_heating_source: 1, duplicate_heating_interval: 1 });
});

Deno.test("shared-meter attribution preserves raw energy and explicit withdrawal provenance", () => {
  const result = parseHeatingObservations([{ ...row, device_energy_kwh: { heater: 1.4 },
    heater_energy_limits_w: { heater: 800 }, invalidated_device_keys: ["heater"] }], start, start + 3_600_000);
  assertEquals(result.observations[0].device_energy_kwh.heater, 1.4);
  assertEquals(result.observations[0].heater_energy_limits_w, { heater: 800 });
  assertEquals(result.observations[0].invalidated_device_keys, ["heater"]);
  const invalid = parseHeatingObservations([{ ...row, heater_energy_limits_w: { other: 800 } },
    { ...row, invalidated_device_keys: ["other"] }], start, start + 3_600_000);
  assertEquals(invalid.observations.length, 0);
});

Deno.test("invalid temperature isolates the field without stalling history acknowledgement", () => {
  const result = parseHeatingObservations([{ ...row, room_temperature_c: 1000 }], start, start + 3_600_000);
  assertEquals(result.observations.length, 1);
  assertEquals(result.observations[0].room_temperature_c, null);
  assertEquals(result.observations[0].device_energy_kwh.heater, .4);
  assertEquals(result.observations[0].outdoor_temperature_c, -12);
  assertEquals(result.ignored, { invalid_heating_reading: 1 });
});
