// Independently generated synthetic charger; no captured household inputs.
import { assertEquals, assertRejects } from "@std/assert";
import { fitStoredDevice } from "./device.ts";

const Q = 900_000;
const NOW = Date.parse("2026-11-08T12:00:00Z");

/** A read-only client over captured rows, paged like PostgREST. */
function database(rows: Record<string, unknown>[], device: { id: string } | null = { id: "charger-id" }) {
  const reads: string[] = [];
  return { reads, db: { from(table: string) {
    const query = {
      select() { return query; }, eq() { return query; }, gte() { return query; }, order() { return query; },
      maybeSingle() { reads.push(table); return Promise.resolve({ data: device, error: null }); },
      range(from: number, to: number) { reads.push(`${table}:${from}`); return Promise.resolve({ data: rows.slice(from, to + 1), error: null }); },
    };
    return query;
  } } };
}

Deno.test("a charger's refit learns its draw at each current over every page", async () => {
  // 90 days of quarters is more than one page; a charging session every evening at 10 A, then 16 A.
  const rows: Record<string, unknown>[] = [];
  const start = Math.floor(NOW / Q) * Q - 90 * 86_400_000;
  for (let i = 0; i < 90 * 96; i++) {
    const charging = i % 96 >= 70 && i % 96 < 86, amps = i < 45 * 96 ? 10 : 16;
    rows.push({ start_ts: new Date(start + i * Q).toISOString(), energy_kwh: charging ? amps * 690 / 4000 : 0,
      power_setting: amps, heat_kwh: null });
  }
  const { db, reads } = database(rows);
  const row = await fitStoredDevice(db, "customer", "home", "synthetic-charger", NOW);
  const learned = row.operating_points as { points: { settings: Record<string, number>; electric_w: Record<string, number> }[] };
  assertEquals(learned.points.map(p => [p.settings["synthetic-charger"], p.electric_w["synthetic-charger"]]), [[10, 6900], [16, 11040]]);
  assertEquals(reads.filter(read => read.startsWith("energy_optimisation_device_slots")).length, 10);
  assertEquals(row.last_fit_attempt, { learning: { method: "device_operating_points_v1" }, issues: [] });
});

Deno.test("a device without quarters publishes no points, and one gone from the inventory is retried", async () => {
  const empty = await fitStoredDevice(database([]).db, "customer", "home", "synthetic-charger", NOW);
  assertEquals((empty.operating_points as { points: unknown[] }).points, []);
  await assertRejects(() => fitStoredDevice(database([], null).db, "customer", "home", "synthetic-charger", NOW), Error, "inventory");
});
