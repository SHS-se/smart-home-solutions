import { assert, assertAlmostEquals, assertEquals, assertRejects } from "@std/assert";
import replayPrices from "./prepared-energy-forecasts.fixture.json" with { type: "json" };
import { buildPriceOutlook } from "./planner/energy-price-shape.ts";
import {
  PREPARED_FORECAST_TABLE,
  type PreparedForecastDatabase,
  PreparedForecastError,
  type PreparedRoom,
  readOrPrepareForecasts,
  readPreparedForecasts,
  storePreparedForecasts,
} from "./prepared-energy-forecasts.ts";
import { input } from "./planner/energy-optimisation.fixture.ts";
import type {
  OptimisationPlan,
  OptimisationSnapshot,
} from "./planner/planning-contracts.ts";

type Publication = Parameters<
  ReturnType<PreparedForecastDatabase["from"]>["upsert"]
>[0];
class Store implements PreparedForecastDatabase {
  row: Publication | null = null;
  readError: { message: string } | null = null;
  writeError: { message: string } | null = null;
  reads: string[] = [];
  writes: Publication[] = [];
  from(table: typeof PREPARED_FORECAST_TABLE) {
    assertEquals(table, PREPARED_FORECAST_TABLE);
    return {
      select: (columns: "issued_at,forecast") => {
        assertEquals(columns, "issued_at,forecast");
        return {
          eq: (column: "home_id", home: string) => {
            assertEquals(column, "home_id");
            this.reads.push(home);
            return {
              maybeSingle: () =>
                Promise.resolve({
                  data: this.row === null ? null : structuredClone(this.row),
                  error: this.readError,
                }),
            };
          },
        };
      },
      upsert: (row: Publication, options: { onConflict: "home_id" }) => {
        assertEquals(options, { onConflict: "home_id" });
        if (this.writeError === null) {
          this.row = structuredClone(row);
          this.writes.push(structuredClone(row));
        }
        return Promise.resolve({ error: this.writeError });
      },
    };
  }
}
function source(): OptimisationSnapshot {
  const s = input();
  s.slots = s.slots.slice(0, 4);
  s.outdoor_temperature_c = [-6, -5, -4, -3];
  s.solar_irradiance_w_per_m2 = [100, 200, 300, 400];
  s.thermal_zones = [];
  return s;
}
function prices(): OptimisationPlan["price_outlook"] {
  return {
    shaped: true,
    observed_days: 20,
    effective_days: 12.5,
    level_sek_per_kwh: 2,
    level_basis: "wind",
    shadow_import_sek_per_kwh: [1.2, 2.3, 3.4, 4.5],
  };
}
function room(): PreparedRoom {
  return {
    key: "study",
    name: "Study",
    device_keys: ["study_heater"],
    rated_power_w: 1000,
    model: {
      gain_c_per_wh: .001,
      cooling_constant_per_h: .1,
      background_gain_c_per_h: .2,
      solar_gain_c_per_h_per_wm2: .001,
      solar_mean_w_per_m2: 100,
      thermal_capacity_wh_per_c: 1000,
      heat_loss_w_per_c: 100,
      time_constant_h: 10,
      heating_rate_c_per_h: 1,
      r2: .9,
      sample_count: 600,
      residual_std_c: .1,
    },
    maximum_power_w_by_slot: [1000, 900, 800, 700],
  };
}

Deno.test("prepared forecast read aligns by timestamp and unchanged published prices remain exact", async () => {
  const db = new Store(), prepared = source();
  prepared.slots[1].import_price_sek_per_kwh = null;
  prepared.slots[2].import_price_sek_per_kwh = -0.0123456789;
  const original = structuredClone(prepared);
  await storePreparedForecasts(db, "home-a", prepared, prices(), [room()]);
  assertEquals(prepared, original);
  assert(db.row);
  // Publication age is evidence, not a made-up expiration or event-order constraint.
  db.row.issued_at = "2000-01-01T00:00:00Z";
  const request = source();
  request.slots = [request.slots[2], request.slots[1]].map((slot, i) => ({
    ...slot,
    start: slot.start.replace("Z", "+00:00"),
    import_price_sek_per_kwh: i === 0 ? -0.0123456789 : null,
  }));
  request.outdoor_temperature_c = [99, 99];
  request.solar_irradiance_w_per_m2 = [999, 999];
  const requestBefore = structuredClone(request);
  const result = await readPreparedForecasts(db, "home-a", request);
  assertEquals(result.price_outlook.shadow_import_sek_per_kwh, [
    -0.0123456789,
    2.3,
  ]);
  assertEquals(result.price_outlook.level_basis, "wind");
  assertEquals(result.snapshot.outdoor_temperature_c, [-4, -5]);
  assertEquals(result.snapshot.solar_irradiance_w_per_m2, [300, 200]);
  assertEquals(result.rooms, [{ ...room(), maximum_power_w_by_slot: [800, 900] }]);
  // Planning zones are built from current preferences, never from the product.
  assertEquals(result.snapshot.thermal_zones, request.thermal_zones);
  assertEquals(request, requestBefore);
  assert(result.snapshot.slots === request.slots);
  assert(result.snapshot.device_models === request.device_models);
  assert(result.snapshot.battery === request.battery);
  assertEquals(db.reads, ["home-a"]);
  assertEquals(db.writes.length, 1);
});

Deno.test("prepared forecast absence and missing horizon coverage fail without fetching or writing", async () => {
  const db = new Store(), request = source();
  const absent = await assertRejects(
    () => readPreparedForecasts(db, "home-a", request),
    PreparedForecastError,
  );
  assertEquals(absent.code, "prepared_forecast_unavailable");
  await storePreparedForecasts(db, "home-a", request, prices());
  request.slots[3].start = new Date(
    Date.parse(request.slots[3].start) + 900_000,
  ).toISOString();
  const missing = await assertRejects(
    () => readPreparedForecasts(db, "home-a", request),
    PreparedForecastError,
  );
  assertEquals(missing.code, "prepared_forecast_coverage_missing");
  assertEquals(db.writes.length, 1);
});

Deno.test("admission prepares a forecast once when none is published or it ends short, and only then", async () => {
  const db = new Store(), request = source();
  let prepared = 0;
  const prepare = async () => {
    prepared++;
    await storePreparedForecasts(db, "home-a", request, prices());
  };
  const first = await readOrPrepareForecasts(db, "home-a", request, prepare);
  assertEquals(first.price_outlook.shadow_import_sek_per_kwh.length, 4);
  await readOrPrepareForecasts(db, "home-a", request, prepare);
  assertEquals(prepared, 1);
  request.slots[3].start = new Date(
    Date.parse(request.slots[3].start) + 900_000,
  ).toISOString();
  await readOrPrepareForecasts(db, "home-a", request, prepare);
  assertEquals(prepared, 2);
  // A preparation that still leaves the horizon uncovered is refused, not repeated.
  const stale = source();
  const short = await assertRejects(
    () =>
      readOrPrepareForecasts(db, "home-a", stale, () => {
        prepared++;
        return Promise.resolve();
      }),
    PreparedForecastError,
  );
  assertEquals(short.code, "prepared_forecast_coverage_missing");
  assertEquals(prepared, 3);
  db.readError = { message: "read failed" };
  const failed = await assertRejects(
    () => readOrPrepareForecasts(db, "home-a", request, prepare),
    PreparedForecastError,
  );
  assertEquals(failed.code, "prepared_forecast_read_failed");
  assertEquals(prepared, 4);
});

Deno.test("a new day-ahead release refreshes the cached tail before admission (14 October replay)", async () => {
  // Only the replay's price data is retained, without household/device details.
  const db = new Store(), request = source();
  request.captured_at = replayPrices.captured_at;
  request.timezone = replayPrices.timezone;
  const start = Date.parse(replayPrices.first_start);
  request.slots = replayPrices.published_import_sek_per_kwh.map((price, i) => ({
    ...request.slots[0], start: new Date(start + i * 900_000).toISOString(), import_price_sek_per_kwh: price,
  }));
  delete request.outdoor_temperature_c;
  delete request.solar_irradiance_w_per_m2;
  const previous = structuredClone(request);
  // Before tomorrow's release only today's remaining 44 quarters were known.
  previous.slots.slice(44).forEach(slot => slot.import_price_sek_per_kwh = null);
  // The replay contains the outlook after published values were overlaid.
  // This also tests a newly published value that matches the old estimate:
  // its publication still moves the boundary the whole tail must start from.
  await storePreparedForecasts(db, "home-a", previous, {
    ...prices(), shadow_import_sek_per_kwh: replayPrices.stale_shadow_import_sek_per_kwh,
  });
  let preparations = 0;
  const prepare = async () => {
    preparations++;
    const fresh = buildPriceOutlook(request.slots, [], { timeZone: request.timezone, asOf: Date.parse(request.captured_at) });
    await storePreparedForecasts(db, "home-a", request, {
      shaped: fresh.shaped, observed_days: fresh.observedDays, effective_days: fresh.effectiveDays,
      level_sek_per_kwh: fresh.levelSekPerKwh, shadow_import_sek_per_kwh: fresh.shadowImportSekPerKwh,
      level_basis: fresh.levelBasis,
    });
  };
  const firstUnpublished = request.slots.findIndex(slot => slot.import_price_sek_per_kwh === null);
  assertEquals(firstUnpublished, 140);
  assertAlmostEquals(replayPrices.stale_shadow_import_sek_per_kwh[140] - request.slots[139].import_price_sek_per_kwh!, .557170122858059);
  const result = await readOrPrepareForecasts(db, "home-a", request, prepare);
  assertEquals(preparations, 1);
  const shadow = result.price_outlook.shadow_import_sek_per_kwh;
  assertEquals(shadow.slice(0, firstUnpublished), request.slots.slice(0, firstUnpublished).map(slot => slot.import_price_sek_per_kwh));
  assertAlmostEquals(shadow[firstUnpublished], .93317);
  assertEquals((await readOrPrepareForecasts(db, "home-a", request, prepare)).price_outlook, result.price_outlook);
  assertEquals(preparations, 1, "an unchanged price release reuses the prepared forecast");
});

Deno.test("a corrected published price refreshes its forecast even with an earlier source timestamp", async () => {
  const db = new Store(), request = source();
  await storePreparedForecasts(db, "home-a", request, prices());
  request.captured_at = "2000-01-01T00:00:00Z";
  request.slots[1].import_price_sek_per_kwh! += .1;
  let preparations = 0;
  await readOrPrepareForecasts(db, "home-a", request, async () => {
    preparations++;
    await storePreparedForecasts(db, "home-a", request, prices());
  });
  assertEquals(preparations, 1);
  request.slots[1].import_price_sek_per_kwh! += .1;
  const stale = await assertRejects(() => readOrPrepareForecasts(db, "home-a", request, async () => {
    preparations++;
  }), PreparedForecastError);
  assertEquals(stale.code, "prepared_forecast_prices_changed");
  assertEquals(preparations, 2, "a preparation that still uses old prices fails without retrying or splicing");
});

Deno.test("forecast publication refuses misaligned data and read rejects malformed stored products", async () => {
  const db = new Store(), prepared = source();
  const invalid = await assertRejects(
    () => storePreparedForecasts(db, "home-a", prepared, prices(), [{ ...room(), maximum_power_w_by_slot: [20] }]),
    PreparedForecastError,
  );
  assertEquals(invalid.code, "prepared_forecast_invalid");
  assertEquals(db.writes.length, 0);
  await storePreparedForecasts(db, "home-a", prepared, prices());
  assert(db.row);
  db.row.forecast.slot_starts[1] = db.row.forecast.slot_starts[0].replace(
    "Z",
    "+00:00",
  );
  const duplicate = await assertRejects(
    () => readPreparedForecasts(db, "home-a", source()),
    PreparedForecastError,
  );
  assertEquals(duplicate.code, "prepared_forecast_invalid");
  await storePreparedForecasts(db, "home-a", source(), prices());
  assert(db.row);
  db.row.forecast.price_outlook.shadow_import_sek_per_kwh.pop();
  await assertRejects(
    () => readPreparedForecasts(db, "home-a", source()),
    PreparedForecastError,
    "does not cover",
  );
});

Deno.test("explicit absent server weather never adopts an incoming weather series", async () => {
  const db = new Store(), prepared = source();
  prepared.slots[0].import_price_sek_per_kwh = 0;
  delete prepared.outdoor_temperature_c;
  delete prepared.solar_irradiance_w_per_m2;
  await storePreparedForecasts(db, "home-a", prepared, prices());
  const request = source();
  request.slots[0].import_price_sek_per_kwh = 0;
  const result = await readPreparedForecasts(db, "home-a", request);
  assertEquals(result.snapshot.outdoor_temperature_c, undefined);
  assertEquals(result.snapshot.solar_irradiance_w_per_m2, null);
  assertEquals(result.rooms, []);
  assertEquals(result.price_outlook.shadow_import_sek_per_kwh[0], 0);
});

Deno.test("service forecast storage errors remain named failures", async () => {
  const db = new Store();
  db.readError = { message: "read failed" };
  const read = await assertRejects(
    () => readPreparedForecasts(db, "home-a", source()),
    PreparedForecastError,
  );
  assertEquals(read.code, "prepared_forecast_read_failed");
  db.writeError = { message: "write failed" };
  const write = await assertRejects(
    () => storePreparedForecasts(db, "home-a", source(), prices()),
    PreparedForecastError,
  );
  assertEquals(write.code, "prepared_forecast_write_failed");
  assertEquals(db.writes, []);
});

Deno.test("a forecast cache read failure still uses fresh prepared service data",async()=>{
 const db=new Store();db.readError={message:"temporarily unavailable"};const snapshot=source();
 const ready={snapshot,price_outlook:prices(),issued_at:snapshot.captured_at,rooms:[room()]};let prepared=0;
 const result=await readOrPrepareForecasts(db,"home-a",snapshot,async()=>{prepared++;return ready;});
 assertEquals(prepared,1);assertEquals(result.issued_at,ready.issued_at);assertEquals(result.price_outlook,ready.price_outlook);assertEquals(result.rooms.length,1);
});

Deno.test("an installation address edit cannot reuse weather cached for a different site",async()=>{
 const db=new Store(),snapshot=source();snapshot.location={latitude:59,longitude:18};
 await storePreparedForecasts(db,"home-a",snapshot,prices());
 snapshot.location={latitude:58,longitude:17};let prepared=0;
 const result=await readOrPrepareForecasts(db,"home-a",snapshot,async()=>{prepared++;
   await storePreparedForecasts(db,"home-a",snapshot,prices());});
 assertEquals(prepared,1);assertEquals(result.snapshot.location,snapshot.location);
});

Deno.test("fresh preparation cannot erase resolved website settings or newer measured state", async () => {
  const db = new Store();
  const request = source(), older = structuredClone(request);
  request.value_settings = {battery_degradation_sek_per_kwh: .12, vehicle_fallback_sek_per_km: null};
  request.comfort = {pool: {target_c: 30}, ev: {target_km: 60}};
  request.grid.import_limit_w = 13000;
  request.captured_at = "2026-10-15T22:30:00Z";
  request.battery = {...request.battery!, soc: .7};
  delete older.value_settings;
  const result = await readOrPrepareForecasts(db, "home-a", request, async () => ({
    snapshot: older, price_outlook: prices(), issued_at: request.captured_at, rooms: [room()],
  }));
  for (const key of ["value_settings", "comfort", "grid", "battery", "captured_at", "services", "device_models", "thermal_zones"] as const) {
    assertEquals(result.snapshot[key], request[key], key);
  }
  assertEquals(result.rooms, [room()]);
});

Deno.test("a product published with finished zones still yields their room evidence, never their comfort", async () => {
  const db = new Store();
  await storePreparedForecasts(db, "home-a", source(), prices());
  assert(db.row);
  // Before 20 October 2026 the product cached each room's Comfort routine and temperature.
  db.row.forecast.thermal_zones = [{ ...room(), start_temperature_c: 20, comfort_min_c: [22, 22, 22, 22],
    target_c: [22, 22, 22, 22], comfort_max_c: [22.5, 22.5, 22.5, 22.5], unplanned_power_w: [0, 0, 0, 0] }];
  delete db.row.forecast.rooms;
  const result = await readPreparedForecasts(db, "home-a", source());
  assertEquals(result.rooms, [room()]);
});
