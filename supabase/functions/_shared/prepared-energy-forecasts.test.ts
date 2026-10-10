import { assert, assertEquals, assertRejects } from "@std/assert";
import {
  PREPARED_FORECAST_TABLE,
  type PreparedForecastDatabase,
  PreparedForecastError,
  readOrPrepareForecasts,
  readPreparedForecasts,
  storePreparedForecasts,
} from "./prepared-energy-forecasts.ts";
import { input } from "./planner/energy-optimisation.fixture.ts";
import type {
  OptimisationPlan,
  OptimisationSnapshot,
  ThermalZonePlanningInput,
} from "./planner/energy-optimisation.ts";

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
function zone(): ThermalZonePlanningInput {
  return {
    key: "study",
    name: "Study",
    device_keys: ["study_heater"],
    start_temperature_c: 20,
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
    comfort_min_c: [18, 19, 20, 21],
    target_c: [19, 20, 21, 22],
    comfort_max_c: [20, 21, 22, 23],
    maximum_power_w_by_slot: [1000, 900, 800, 700],
    unplanned_power_w: [10, 20, 30, 40],
  };
}

Deno.test("prepared forecast read aligns by timestamp and newly published prices remain exact", async () => {
  const db = new Store(), prepared = source();
  prepared.thermal_zones = [zone()];
  const original = structuredClone(prepared);
  await storePreparedForecasts(db, "home-a", prepared, prices());
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
  assertEquals(result.snapshot.thermal_zones, [{
    ...zone(),
    comfort_min_c: [20, 19],
    target_c: [21, 20],
    comfort_max_c: [22, 21],
    maximum_power_w_by_slot: [800, 900],
    unplanned_power_w: [30, 20],
  }]);
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
  assertEquals(prepared, 3);
});

Deno.test("forecast publication refuses misaligned data and read rejects malformed stored products", async () => {
  const db = new Store(), prepared = source();
  prepared.thermal_zones = [{ ...zone(), target_c: [20] }];
  const invalid = await assertRejects(
    () => storePreparedForecasts(db, "home-a", prepared, prices()),
    PreparedForecastError,
  );
  assertEquals(invalid.code, "prepared_forecast_invalid");
  assertEquals(db.writes.length, 0);
  prepared.thermal_zones = [];
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
  delete prepared.outdoor_temperature_c;
  delete prepared.solar_irradiance_w_per_m2;
  delete prepared.thermal_zones;
  await storePreparedForecasts(db, "home-a", prepared, prices());
  const request = source();
  request.thermal_zones = [zone()];
  request.slots[0].import_price_sek_per_kwh = 0;
  const result = await readPreparedForecasts(db, "home-a", request);
  assertEquals(result.snapshot.outdoor_temperature_c, undefined);
  assertEquals(result.snapshot.solar_irradiance_w_per_m2, null);
  assertEquals(result.snapshot.thermal_zones, []);
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
