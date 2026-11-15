// A device observation from the home's upload, through storage, into the learner.
//
// Independently generated synthetic equipment; no captured household inputs.
// The upload rows have the shape the Home Assistant app sends: a household
// meter row that also carries each device's energy, the power setting that
// held through the quarter and the heat metered in it.
import { assertEquals } from "@std/assert";
import { prepareActualUpload, upsertGroups } from "./actual-upload.ts";
import { fitStoredDevice } from "./device-model-learning/device.ts";

const Q = 900_000;
const NOW = Date.parse("2026-11-10T12:07:00Z");
const END = Math.floor(NOW / Q) * Q;
const KEY = "synthetic-heat-pump";
const QUALITY = { aggregation: "sum_of_recorder_5minute_changes", duration_seconds: 900 };
const CONTEXT = { customer_id: "customer", home_id: "home", device_token_id: "token" };
const DEVICES = new Map([[KEY, { id: "device" }]]);

/** The device-slot table with the storage's own upsert: on a conflict, only
 * the columns an upsert names are written. */
function storage() {
  const rows = new Map<string, Record<string, unknown>>();
  const upsert = (batch: Record<string, unknown>[]) => {
    assertEquals(new Set(batch.map(row => Object.keys(row).sort().join(","))).size, 1, "one upsert names one set of columns");
    for (const row of batch) {
      const id = `${row.device_id}|${row.start_ts}`;
      rows.set(id, { power_setting: null, heat_kwh: null, quality: {}, ...rows.get(id), ...row });
    }
  };
  const sorted = () => [...rows.values()].sort((a, b) => String(a.start_ts).localeCompare(String(b.start_ts)));
  const db = { from(table: string) {
    const query = {
      select() { return query; }, eq() { return query; }, gte() { return query; }, order() { return query; },
      maybeSingle: () => Promise.resolve({ data: table === "energy_optimisation_devices" ? { id: "device" } : null, error: null }),
      range: (from: number, to: number) => Promise.resolve({ data: sorted().slice(from, to + 1), error: null }),
    };
    return query;
  } };
  return { rows, sorted, db, receive(upload: unknown[], at = NOW) {
    const prepared = prepareActualUpload(upload, DEVICES, CONTEXT, at);
    for (const group of upsertGroups(prepared.deviceSlotRows)) upsert(group);
    return prepared;
  } };
}

/** Quarters `from..to` before END: the heat pump runs at `setting`, drawing `watts`. */
function quarters(from: number, to: number, setting: number | null | undefined, watts: number, heat = true) {
  const upload: Record<string, unknown>[] = [];
  for (let back = from; back > to; back--) {
    // Four hours on, four off: each run and the heat that follows it is one whole session.
    const running = back % 32 >= 16;
    const kwh = running ? watts / 4000 : 0;
    upload.push({ start: new Date(END - back * Q).toISOString(), quality: QUALITY, total_load_kwh: 1 + kwh,
      device_energy_kwh: { [KEY]: kwh },
      ...(setting === undefined ? {} : { device_power_setting: { [KEY]: setting } }),
      ...(heat ? { device_heat_kwh: { [KEY]: kwh * 4 } } : {}) });
  }
  return upload;
}

const learned = async (db: unknown) => {
  const row = await fitStoredDevice(db, "customer", "home", KEY, NOW);
  return (row.operating_points as { points: { settings: Record<string, number>; electric_w: Record<string, number>; cop: number | null; steady_hours: number }[] }).points;
};

Deno.test("PIPELINE: a quarter beside a household row reaches the learner with its setting and heat", async () => {
  const store = storage();
  // Two days at 8, then two at 12: the setting separates the two draws.
  const prepared = store.receive([...quarters(384, 192, 8, 1600), ...quarters(192, 0, 12, 3000)]);
  assertEquals(prepared.actualRows.length, 384);
  assertEquals(prepared.ignored, {});
  assertEquals(store.sorted().filter(row => row.power_setting === null || row.heat_kwh === null).length, 0);
  const points = await learned(store.db);
  assertEquals(points.map(p => [p.settings[KEY], p.electric_w[KEY], p.cop]), [[12, 3000, 4], [8, 1600, 4]]);
});

Deno.test("PIPELINE: a sweep that could not read the setting does not erase it, and none held clears it", async () => {
  const store = storage();
  store.receive(quarters(192, 0, 12, 3000));
  const before = structuredClone(store.sorted());
  // The same quarters again: the setting and the heat meter could not be read.
  store.receive(quarters(8, 0, undefined, 3000, false));
  assertEquals(store.sorted(), before);
  // Read again, and no single value held through the newest quarter.
  store.receive(quarters(1, 0, null, 3000));
  assertEquals(store.sorted().at(-1)!.power_setting, null);
  assertEquals(store.sorted().slice(0, -1), before.slice(0, -1));
});

Deno.test("PIPELINE: duplicate, out-of-order and repeated uploads store the same quarters once", async () => {
  const whole = quarters(192, 0, 12, 3000);
  const once = storage();
  once.receive(whole);
  const shuffled = storage();
  // Newest first, an overlap, then the older half twice.
  shuffled.receive(whole.slice(96));
  shuffled.receive(whole.slice(64, 128));
  shuffled.receive(whole.slice(0, 96));
  shuffled.receive(whole.slice(0, 96));
  assertEquals(shuffled.sorted(), once.sorted());
  assertEquals(shuffled.rows.size, 192);
  assertEquals(await learned(shuffled.db), await learned(once.db));
  // The same start twice in one upload is stored once, not added.
  const twice = storage();
  const prepared = twice.receive([whole[0], whole[0]]);
  assertEquals([twice.rows.size, prepared.ignored.duplicate_actual_start], [1, 1]);
});

Deno.test("PIPELINE: a corrected reading replaces the quarter and the learner follows", async () => {
  const store = storage();
  store.receive(quarters(192, 0, 12, 3000));
  assertEquals((await learned(store.db)).map(p => p.electric_w[KEY]), [3000]);
  // The whole history again with a corrected meter: 2800 W, not 3000 W.
  store.receive(quarters(192, 0, 12, 2800));
  assertEquals(store.rows.size, 192);
  assertEquals((await learned(store.db)).map(p => [p.electric_w[KEY], p.cop]), [[2800, 4]]);
});

Deno.test("PIPELINE: quarters without a setting are not attributed to one once any quarter carries it", async () => {
  const store = storage();
  // Older quarters were stored before settings were sent: a different draw, unlabelled.
  store.receive([...quarters(384, 192, undefined, 1600), ...quarters(192, 0, 12, 3000)]);
  const points = await learned(store.db);
  assertEquals(points.map(p => [p.settings, p.electric_w[KEY]]), [[{ [KEY]: 12 }, 3000]]);
});
