import { assertEquals } from "@std/assert";
import { ingestHeatingHistory } from "./heating-history-ingest.ts";

// Independently generated transport examples, not household captures.
const start = Date.UTC(2025, 0, 1), source = "a".repeat(64);
const input = { homeId: "synthetic-home", customerId: "synthetic-customer", fromMs: start, toMs: start + 3_600_000,
  observations: [{ room_key: "room", source_key: source, start: new Date(start).toISOString(), duration_s: 3600,
    source: "recorder_hour_mean", room_temperature_c: 20, outdoor_temperature_c: -5, house_temperature_c: 21,
    device_statistics: { heater: "sensor.synthetic_energy" }, device_energy_kwh: { heater: .5 }, cooling: false }],
  probes: [{ start: new Date(start).toISOString(), duration_s: 3600, probes: [{ source_key: source,
    area_key: "room", mean: 20, unchanged: true, joint_unchanged: null, cohort_key: null, reported: null, unavailable: null }] }],
};
type Database = Parameters<typeof ingestHeatingHistory>[0];
const receipt = { accepted: 1, accepted_by_source: [{ room_key: "room", source_key: source, accepted: 1 }] };

Deno.test("probe storage and lineage outages preserve measured heat receipts and do not revoke source configuration", async () => {
  const calls: string[] = [];
  const db = { rpc: (name: string) => {
    calls.push(name);
    return Promise.resolve(name === "record_energy_heating_observations"
      ? { data: receipt, error: null } : { data: null, error: { message: "synthetic unavailable storage" } });
  } } as unknown as Database;
  const result = await ingestHeatingHistory(db, input);
  assertEquals(calls.length, 3);
  assertEquals(result.exchange.heating_observations_accepted, 1);
  assertEquals(result.exchange.heating_observations_accepted_by_source, receipt.accepted_by_source);
  assertEquals(result.exchange.heating_probe_observations_accepted, null);
  assertEquals(Object.hasOwn(result.exchange, "heating_history_sources"), false);
  assertEquals(result.ignored, {});
});

Deno.test("a transient heat write failure still syncs reviewed sources and shared probe facts", async () => {
  const configuration = { revision: "synthetic-revision", assignments: [] };
  const db = { rpc: (name: string) => {
    if (name === "record_energy_heating_observations") throw new Error("synthetic transport interruption");
    return Promise.resolve({ data: name === "get_energy_heating_history_sources" ? configuration : 1, error: null });
  } } as unknown as Database;
  const result = await ingestHeatingHistory(db, input);
  assertEquals(result.exchange, { heating_observations_accepted: null, heating_observations_accepted_by_source: null,
    heating_probe_observations_accepted: 1, heating_history_sources: configuration, heating_power_peaks_supported: true,
    heating_history_errors: ["Heating history: the server could not store the upload. SHS will retry automatically."] });
});

Deno.test("a database timeout names the failed history write while other receipts continue", async () => {
  const configuration = { revision: "synthetic-revision", assignments: [] };
  const db = { rpc: (name: string) => Promise.resolve(name === "record_energy_heating_observations"
    ? { data: null, error: { code: "57014", message: "canceling statement due to statement timeout" } }
    : { data: name === "get_energy_heating_history_sources" ? configuration : 1, error: null }) } as unknown as Database;
  const result = await ingestHeatingHistory(db, input);
  assertEquals(result.exchange.heating_history_errors,
    ["Heating history: the server database write timed out. SHS will retry automatically."]);
  assertEquals(result.exchange.heating_observations_accepted, null);
  assertEquals(result.exchange.heating_probe_observations_accepted, 1);
  assertEquals(result.exchange.heating_history_sources, configuration);
});

Deno.test("heat pump peaks are stored after their intervals, and a failed peak write retries the window", async () => {
  const peaked = { ...input, observations: [{ ...input.observations[0], device_peak_w: { heater: 2900 } }] };
  const sent: unknown[] = [];
  const working = { rpc: (name: string, args: { p_rows?: unknown }) => {
    if (name === "record_energy_heating_power_peaks") sent.push(args.p_rows);
    return Promise.resolve({ data: name === "record_energy_heating_observations" ? receipt : 1, error: null });
  } } as unknown as Database;
  const stored = await ingestHeatingHistory(working, peaked);
  assertEquals(sent, [[{ device_key: "heater", start: new Date(start).toISOString(), duration_s: 3600, peak_w: 2900 }]]);
  assertEquals(stored.exchange.heating_observations_accepted, 1);
  const failing = { rpc: (name: string) => Promise.resolve(name === "record_energy_heating_power_peaks"
    ? { data: null, error: { message: "synthetic unavailable storage" } }
    : { data: name === "record_energy_heating_observations" ? receipt : 1, error: null }) } as unknown as Database;
  const retried = await ingestHeatingHistory(failing, peaked);
  assertEquals(retried.exchange.heating_observations_accepted, null);
  assertEquals(retried.exchange.heating_history_errors.length, 1);
});
