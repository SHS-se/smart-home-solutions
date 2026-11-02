/** Synthetic measurements and forecasts, independent of measured provider history. */
import { assert, assertEquals, assertRejects, assertThrows } from "@std/assert";
import { collectionPlan } from "../supabase/functions/_shared/market-collection-plan.ts";
import { parseSmhiObservations } from "../supabase/functions/_shared/smhi-observations.ts";
import {
  type WeatherForecastEvidence,
  type WeatherTruthEvidence,
  weatherValidation,
} from "../supabase/functions/_shared/weather-forecast-quality.ts";
import { parseMediumRangeWeather } from "../supabase/functions/_shared/medium-range-weather.ts";
import { marketDaySpan } from "../supabase/functions/_shared/demand-forecast-quality.ts";
import { ZONE_STATIONS } from "../supabase/functions/_shared/market-wind.ts";
import { assessMarketObservation } from "../supabase/functions/_shared/market-evidence-assessment.ts";
import {
  createMarketQualityHandler,
  type QualityStore,
} from "../supabase/functions/energy-market-quality/index.ts";
import { marketFoundationDb } from "./helpers/market-foundation-db.ts";
import { mediumRangeWeatherFixture } from "./medium-range-weather.fixture.ts";
const UUID = (n: number) =>
  `${String(n).padStart(8, "0")}-2222-4222-8222-222222222222`;
const request = {
  dataset: "smhi_wind_10m_observed" as const,
  station_id: "83190",
  from: "2026-10-24T00:00:00Z",
  to: "2026-10-27T00:00:00Z",
};
const native = () => ({
  updated: Date.parse(request.to),
  parameter: { key: "4", unit: "meter per sekund" },
  station: { key: "83190", height: 10 },
  period: {
    key: "latest-months",
    from: Date.parse(request.from),
    to: Date.parse(request.to),
    sampling: "10 minuter",
  },
  position: [{
    from: 0,
    to: Date.parse(request.to),
    latitude: 58.3218,
    longitude: 13.0379,
    height: 70,
  }],
  value: [
    { date: Date.parse("2026-10-25T00:00Z"), value: "1.5", quality: "G" },
    { date: Date.parse("2026-10-25T01:00Z"), value: "3", quality: "Y" },
  ],
});
Deno.test("weather truth has twenty unique station intents and validates native identity, quality and conflicts without filling gaps", () => {
  const plan = collectionPlan("weather_truth", new Date("2026-10-25T12:37Z"));
  assertEquals(plan.length, 20);
  assertEquals(new Set(plan.map((p) => p.key)).size, 20);
  const doc = parseSmhiObservations(native(), request);
  assertEquals(doc.height_m, 10);
  assertEquals(doc.hours.map((v) => v.quality), ["G", "Y"]);
  const duplicate = native();
  duplicate.value.push({ ...duplicate.value[0], value: "5" });
  assertEquals(
    parseSmhiObservations(duplicate, request).hours[0].conflict,
    true,
  );
  assertEquals(parseSmhiObservations(duplicate, request).hours[0].value, null);
  const wrong = native();
  wrong.station.height = 2;
  assertThrows(() => parseSmhiObservations(wrong, request));
  const unknown = native();
  unknown.value[0].quality = "unknown";
  assertEquals(
    parseSmhiObservations(unknown, request).hours[0].quality,
    "unknown",
  );
  const assessment = assessMarketObservation({
    id: UUID(1),
    dataset: request.dataset,
    zone: "SE3",
    requested_from: request.from,
    requested_to: request.to,
    result: { status: "data", document: doc },
  });
  assertEquals(assessment.facts.kind, "station_hourly_truth");
  assertEquals(assessment.facts.station_id, "83190");
  assert(!("missing_se3_labels" in assessment.facts));
  const failed = assessMarketObservation({
    id: UUID(2),
    dataset: request.dataset,
    zone: "SE3",
    requested_from: request.from,
    requested_to: request.to,
    result: { status: "provider_error", request: { station_id: "83190" } },
  });
  assertEquals(failed.facts.station_id, "83190");
});
function fixture(day: string) {
  const [start, end] = marketDaySpan(day),
    times = Array.from(
      { length: (end - start) / 3_600_000 },
      (_, i) => new Date(start + i * 3_600_000).toISOString(),
    );
  const origin = new Date(start - 3_600_000).toISOString();
  const forecast: WeatherForecastEvidence = {
    id: UUID(1),
    sequence: 1,
    recorded_at: origin,
    requested_from: new Date(start - 28 * 86_400_000).toISOString(),
    requested_to: new Date(end).toISOString(),
    result: {
      status: "data",
      document: parseMediumRangeWeather(
        mediumRangeWeatherFixture(times),
        origin,
      ),
    },
  };
  forecast.result.document!.sites = forecast.result.document!.sites.slice(0, 1);
  const raw = native();
  raw.period.to = end;
  raw.position[0].to = end;
  raw.value = times.map((t) => ({
    date: Date.parse(t),
    value: "1.38",
    quality: "G",
  }));
  const req = {
    ...request,
    from: new Date(start).toISOString(),
    to: new Date(end).toISOString(),
  };
  const truth: WeatherTruthEvidence = {
    id: UUID(2),
    sequence: 2,
    requested_from: req.from,
    requested_to: req.to,
    result: { status: "data", document: parseSmhiObservations(raw, req) },
  };
  return { start, end, forecast, truth };
}
Deno.test("weather scoring excludes past acquisition, separates G/Y, handles 23/25-hour dates and supersedes older omissions", () => {
  for (
    const [day, count] of [["2026-03-29", 23], ["2026-10-25", 25]] as const
  ) {
    const { start, end, forecast, truth } = fixture(day),
      validation = weatherValidation([truth], { from: start, to: end });
    validation.add([forecast]);
    const cell = validation.result().cells.find((c) =>
      c.variable === "wind_speed_10m" && c.quality === "G"
    )!;
    assertEquals(cell.matched, count);
    assert(Math.abs(cell.mae! - 2) < 1e-9);
    assertEquals(cell.target_dates, 1);
    const revision = structuredClone(truth);
    revision.id = UUID(3);
    revision.sequence = 3;
    revision.result.document!.hours.shift();
    const revised = weatherValidation([truth, revision], {
      from: start,
      to: end,
    });
    revised.add([forecast]);
    assertEquals(
      revised.result().cells.find((c) =>
        c.variable === "wind_speed_10m" && c.quality === "G"
      )!.matched,
      count - 1,
    );
    const provisional = structuredClone(truth);
    provisional.result.document!.hours[0].quality = "Y";
    const separated = weatherValidation([provisional], {
      from: start,
      to: end,
    });
    separated.add([forecast]);
    assertEquals(
      separated.result().cells.find((c) =>
        c.variable === "wind_speed_10m" && c.quality === "Y"
      )!.matched,
      1,
    );
    const late = weatherValidation([truth], { from: start, to: end });
    late.add([{
      ...forecast,
      recorded_at: new Date(start + 3_600_000).toISOString(),
    }]);
    assertEquals(late.result().cells.length, 0);
  }
});
Deno.test("weather matching rejects relocated stations and prevents duplicate origin dates across streamed pages", () => {
  const { start, end, forecast, truth } = fixture("2026-10-25");
  truth.result.document!.positions[0].latitude = 61;
  const score = weatherValidation([truth], { from: start, to: end });
  score.add([forecast]);
  assert(score.result().cells.some((c) => c.site_mismatch > 0));
  assertThrows(() => score.add([forecast]));
});
const migration =
  "supabase/migrations/20261101162000_weather_accuracy_quality_monitor.sql";
async function database() {
  const db = await marketFoundationDb();
  await db.exec(
    await Deno.readTextFile(
      "supabase/migrations/20261101144000_market_data_foundation.sql",
    ),
  );
  await db.exec(await Deno.readTextFile(migration));
  await db.exec("SELECT private.enable_test_market_archive()");
  return db;
}
Deno.test("quality results freeze manifests, deduplicate unchanged problems and retain recovery and stale-execution ordering", async () => {
  const db = await database();
  try {
    const problem = {
      key: "synthetic/source",
      severity: "problem",
      fingerprint: { rule: "missing" },
      detail: { count: 1 },
    };
    async function commit(slot: string, problems: unknown[]) {
      const id = (await db.query<{ id: string }>(
        "SELECT private.open_test_market_quality('weather_accuracy',$1,'{}') id",
        [slot],
      )).rows[0].id;
      await db.query("SELECT complete_test_market_accuracy($1,$2,$3)", [id, {
        synthetic: true,
      }, problems]);
      return id;
    }
    const first = await commit("2026-10-25T00:00Z", [problem]);
    await db.query("SELECT complete_test_market_accuracy($1,$2,$3)", [first, {
      synthetic: true,
    }, [problem]]);
    await commit("2026-10-26T00:00Z", [{ ...problem, detail: { count: 2 } }]);
    assertEquals(
      (await db.query("SELECT event FROM energy_market_quality_events")).rows,
      [{ event: "opened" }],
    );
    await commit("2026-10-27T00:00Z", []);
    await commit("2026-10-24T00:00Z", [problem]);
    assertEquals(
      (await db.query(
        "SELECT event FROM energy_market_quality_events ORDER BY sequence",
      )).rows,
      [{ event: "opened" }, { event: "recovered" }],
    );
    await db.exec("SET ROLE service_role");
    await assertRejects(() =>
      db.exec("DELETE FROM energy_market_quality_events")
    );
    await db.exec("RESET ROLE; SET ROLE authenticated");
    await assertRejects(() =>
      db.exec("SELECT read_test_market_quality_status()")
    );
    await db.exec("RESET ROLE");
  } finally {
    await db.close();
  }
});
Deno.test("SQL health operates without HTTP, is quiet on repeat runs and exposes stale evaluators", async () => {
  const db = await database();
  try {
    await db.exec(
      "SELECT private.enable_test_market_quality(); SELECT private.evaluate_test_market_health()",
    );
    const first = (await db.query<{ n: number }>(
      "SELECT count(*)::integer n FROM energy_market_quality_events",
    )).rows[0].n;
    assert(first >= 6);
    await db.exec("SELECT private.evaluate_test_market_health()");
    assertEquals(
      (await db.query<{ n: number }>(
        "SELECT count(*)::integer n FROM energy_market_quality_events",
      )).rows[0].n,
      first,
    );
    const status = (await db.query<{ s: { open_problems: unknown[] } }>(
      "SELECT read_test_market_quality_status() s",
    )).rows[0].s;
    assert(status.open_problems.length >= 6);
  } finally {
    await db.close();
  }
});
Deno.test("quality worker refuses production and retries completed daily evaluations without reading raw history", async () => {
  const calls: string[] = [];
  const store: QualityStore = {
    verifyToken() {
      calls.push("auth");
      return Promise.resolve(true);
    },
    begin(kind) {
      calls.push("begin");
      return Promise.resolve({
        id: UUID(1),
        kind,
        complete: true,
        manifest: {
          snapshot_at: "2026-10-25T12:00Z",
          from: "2026-10-01T00:00Z",
          to: "2026-10-25T00:00Z",
          forecast_ids: [],
          truth_ids: [],
        },
      });
    },
    documents() {
      throw new Error("unnecessary read");
    },
    complete() {
      throw new Error("unnecessary write");
    },
  };
  const req = () =>
    new Request("https://example.test", {
      method: "POST",
      headers: { "x-energy-market-archive-token": "synthetic" },
      body: '{"kind":"weather_accuracy"}',
    });
  assertEquals(
    (await createMarketQualityHandler("https://production.test", store)(req()))
      .status,
    403,
  );
  assertEquals(calls, []);
  const response = await createMarketQualityHandler(
    "https://vxqpgbzseckgceopitpm.supabase.co",
    store,
  )(req());
  assertEquals(response.status, 200);
  assertEquals((await response.json()).status, "already_complete");
});
Deno.test("weather truth commits only for the planned station, and regional monitoring distinguishes border scopes", async () => {
  const db = await database();
  try {
    await db.exec(
      await Deno.readTextFile(
        "supabase/migrations/20261101164000_verified_regional_context.sql",
      ),
    );
    const plan = collectionPlan("weather_truth", new Date("2026-10-25T12:37Z")),
      p = plan[0],
      id = UUID(20);
    await db.query(
      "INSERT INTO energy_market_collection_batches(id,kind,requested_at,plan) VALUES($1,$2,$3,$4)",
      [id, "weather_truth", "2026-10-25T12:37Z", plan],
    );
    const row = {
      id: UUID(21),
      batch_id: id,
      request_key: p.key,
      dataset: p.dataset,
      zone: p.zone,
      requested_from: p.from,
      requested_to: p.to,
      requested_at: "2026-10-25T12:37Z",
      resolved_at: "2026-10-25T12:38Z",
      result: {
        status: "provider_error",
        http_status: 503,
        error_code: "http_503",
        request: { dataset: p.dataset, station_id: "wrong" },
      },
    };
    await assertRejects(() =>
      db.query("SELECT record_test_market_observation($1,$2)", [
        row,
        assessMarketObservation(row),
      ])
    );
    row.result.request.station_id = p.station_id!;
    await db.query("SELECT record_test_market_observation($1,$2)", [
      row,
      assessMarketObservation(row),
    ]);
    await db.exec("SELECT private.evaluate_test_market_health()");
    const health =
      (await db.query<{ s: { open_problems: { problem_key: string }[] } }>(
        "SELECT read_test_market_quality_status() s",
      )).rows[0].s;
    assert(health.open_problems.some((p) => p.problem_key.includes("83190")));
    const regional = collectionPlan(
      "regional_context",
      new Date("2026-11-01T12:00Z"),
    );
    assertEquals(regional.length, 20);
    assertEquals(new Set(regional.map((r) => r.key)).size, 20);
  } finally {
    await db.close();
  }
});
