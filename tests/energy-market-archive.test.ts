import { assertEquals, assertMatch } from "@std/assert";
import { createMarketArchiveHandler, type MarketArchiveObservation, type MarketArchiveStore, type GenerationForecastRun } from "../supabase/functions/energy-market-archive/index.ts";
import { mediumRangeWeatherFixture } from "./medium-range-weather.fixture.ts";

const TEST = "https://vxqpgbzseckgceopitpm.supabase.co";
const config = { projectUrl: TEST, entsoeToken: "private-provider-token" };
const now = () => new Date("2026-10-24T20:15:00.000Z");
const weather = () => Response.json(mediumRangeWeatherFixture());
const request = (token = "private-cron-token") => new Request(`${TEST}/functions/v1/energy-market-archive`, {
  method: "POST", headers: { "x-energy-market-archive-token": token },
});
const hourly = `<GL_MarketDocument><mRID>doc-1</mRID><revisionNumber>2</revisionNumber><process.processType>A01</process.processType>
<createdDateTime>2026-10-24T08:00Z</createdDateTime><TimeSeries><mRID>series-1</mRID><businessType>A01</businessType><curveType>A01</curveType>
<quantity_Measure_Unit.name>MAW</quantity_Measure_Unit.name><Period><timeInterval><start>2026-10-24T22:00Z</start><end>2026-10-24T23:00Z</end></timeInterval>
<resolution>PT60M</resolution><Point><position>1</position><quantity>1000</quantity></Point></Period></TimeSeries></GL_MarketDocument>`;
function storage() {
  const rows: MarketArchiveObservation[] = [];
  const runs: GenerationForecastRun[] = [];
  let verified = 0;
  const store: MarketArchiveStore = {
    verifyToken(token) { verified++; return Promise.resolve(token === "private-cron-token"); },
    saveObservation(row) { rows.push(row); return Promise.resolve(); },
    saveGenerationRun(row) { runs.push(row); return Promise.resolve(); },
  };
  return { rows, runs, store, verified: () => verified };
}

Deno.test("market archive checks exact TEST and private custom token before any provider request", async () => {
  const db = storage();
  let calls = 0;
  const upstream: typeof fetch = () => { calls++; return Promise.resolve(new Response(hourly)); };
  for (const projectUrl of ["https://oosxndduqzhvrorgogaw.supabase.co", "", `${TEST}/other`, TEST.replace("https:", "http:")]) {
    assertEquals((await createMarketArchiveHandler({ ...config, projectUrl }, db.store, upstream, now)(request())).status, 403);
  }
  assertEquals(db.verified(), 0);
  assertEquals((await createMarketArchiveHandler(config, db.store, upstream, now)(request("wrong"))).status, 401);
  assertEquals((await createMarketArchiveHandler(config, db.store, upstream, now)(request(""))).status, 401);
  assertEquals(calls, 0);
  assertEquals(db.rows.length, 0);
});

Deno.test("market archive records native market and seven-day weather windows and appends repeated observations", async () => {
  const db = storage(), queries: URLSearchParams[] = [];
  const upstream: typeof fetch = (input, init) => {
    const url = new URL(String(input));
    if (url.hostname === "api.open-meteo.com") {
      assertEquals(url.searchParams.get("securityToken"), null);
      assertEquals(url.searchParams.get("models"), "ecmwf_ifs025");
      assertEquals(url.searchParams.get("forecast_days"), "7");
      assertEquals(url.searchParams.get("latitude")?.split(",").length, 10);
      return Promise.resolve(weather());
    }
    assertEquals(`${url.origin}${url.pathname}`, "https://web-api.tp.entsoe.eu/api");
    assertEquals(url.searchParams.get("securityToken"), config.entsoeToken);
    assertEquals(init?.redirect, "error");
    queries.push(url.searchParams);
    return Promise.resolve(new Response(hourly));
  };
  const handler = createMarketArchiveHandler(config, db.store, upstream, now);
  assertEquals((await handler(request())).status, 200);
  assertEquals((await handler(request())).status, 200);
  assertEquals(db.rows.length, 8);
  assertEquals(new Set(db.rows.map(row => row.id)).size, 8);
  assertEquals(db.rows.map(row => row.dataset).sort(), ["wind_day_ahead", "load_day_ahead", "load_week_ahead", "weather_medium_range", "wind_day_ahead", "load_day_ahead", "load_week_ahead", "weather_medium_range"].sort());
  assertEquals(queries.slice(0, 3).map(query => [query.get("documentType"), query.get("processType"), query.get("periodStart"), query.get("periodEnd")]), [
    ["A69", "A01", "202610240000", "202610270000"],
    ["A65", "A01", "202610240000", "202610270000"],
    ["A65", "A31", "202610240000", "202611020000"],
  ]);
  for (const row of db.rows) {
    assertEquals(row.zone, "SE3");
    assertEquals(row.requested_at, now().toISOString());
    assertEquals(row.resolved_at, now().toISOString());
    assertEquals(row.result.status, "data");
    if (!("body_sha256" in row.result)) throw new Error("Unexpected research source in ordinary hourly collection");
    assertMatch(row.result.body_sha256!, /^[a-f0-9]{64}$/);
    if (row.dataset === "weather_medium_range") {
      assertEquals(row.requested_to, "2026-10-31T00:00:00.000Z");
      assertEquals(row.result.request.model, "ecmwf_ifs025");
      if (row.result.status !== "data") throw new Error("Expected weather data");
      assertEquals(row.result.document.issue_time, null);
      assertEquals(row.result.document.sites.length, 10);
      continue;
    }
    if (row.result.status !== "data") throw new Error("Expected data");
    if (!("documentId" in row.result.document)) throw new Error("Unexpected research document in ordinary hourly collection");
    assertEquals(row.result.document.documentId, "doc-1");
    assertEquals(row.result.document.revisionNumber, "2");
  }
  for (const dataset of ["wind_day_ahead", "load_day_ahead", "load_week_ahead", "weather_medium_range"]) {
    const repeated = db.rows.filter(row => row.dataset === dataset);
    assertEquals(repeated.length, 2);
    const first = repeated[0].result, second = repeated[1].result;
    if (!("body_sha256" in first) || !("body_sha256" in second)) throw new Error("Unexpected research source");
    assertEquals(first.body_sha256, second.body_sha256);
  }
});

Deno.test("market archive fetches all four datasets concurrently and waits for partial storage failures", async () => {
  const db = storage();
  let entered = 0;
  let allEntered: () => void = () => {};
  const ready = new Promise<void>(resolve => { allEntered = resolve; });
  const upstream: typeof fetch = async () => {
    entered++;
    if (entered === 4) allEntered();
    await ready;
    return new Response(hourly);
  };
  const store: MarketArchiveStore = { ...db.store, saveObservation(row) {
    if (row.dataset === "load_day_ahead") return Promise.reject(new Error("private db detail"));
    return db.store.saveObservation(row);
  } };
  const response = await createMarketArchiveHandler(config, store, upstream, now)(request());
  assertEquals(response.status, 500);
  const body = await response.json();
  assertEquals(body.error, "archive_storage_failed");
  assertEquals(body.observations.length, 3);
  assertEquals(db.rows.length, 3);
});

Deno.test("market archive preserves no-data and provider failures while concealing credentials", async () => {
  const db = storage();
  const upstream: typeof fetch = input => {
    const url = new URL(String(input));
    if (url.searchParams.get("documentType") === "A69") return Promise.resolve(new Response(`<Acknowledgement_MarketDocument><Reason><code>999</code><text>No matching data found</text></Reason></Acknowledgement_MarketDocument>`));
    if (url.searchParams.get("processType") === "A01") return Promise.resolve(new Response(`upstream ${config.entsoeToken} ${encodeURIComponent(config.entsoeToken)}`, { status: 599 }));
    throw new Error(`connection failed ${url}`);
  };
  const response = await createMarketArchiveHandler(config, db.store, upstream, now)(request());
  assertEquals(response.status, 200);
  const byDataset = new Map(db.rows.map(row => [row.dataset, row]));
  assertEquals(byDataset.get("wind_day_ahead")?.result.status, "no_data");
  assertEquals(byDataset.get("load_day_ahead")?.result.status, "provider_error");
  const failedLoad = byDataset.get("load_day_ahead");
  if (failedLoad?.dataset !== "load_day_ahead") throw new Error("Missing load outcome");
  assertEquals(failedLoad.result.raw_xml, "upstream [REDACTED] [REDACTED]");
  assertEquals(byDataset.get("load_week_ahead")?.result.status, "transport_error");
  const failedWeek = byDataset.get("load_week_ahead");
  if (failedWeek?.dataset !== "load_week_ahead") throw new Error("Missing load outcome");
  assertEquals(failedWeek.result.raw_xml, null);
  assertEquals(JSON.stringify(db.rows).includes(config.entsoeToken), false);
  assertEquals((await response.text()).includes(config.entsoeToken), false);
});

Deno.test("market archive separately records malformed XML and HTTP-200 error acknowledgements", async () => {
  const db = storage();
  const upstream: typeof fetch = input => {
    const process = new URL(String(input)).searchParams.get("processType");
    return Promise.resolve(new Response(process === "A31" ? "<broken>" : `<Acknowledgement_MarketDocument><Reason><code>999</code><text>Invalid API query</text></Reason></Acknowledgement_MarketDocument>`));
  };
  const response = await createMarketArchiveHandler(config, db.store, upstream, now)(request());
  assertEquals(response.status, 200);
  assertEquals(Object.fromEntries(db.rows.map(row => [row.dataset, row.result.status])), {
    wind_day_ahead: "provider_error", load_day_ahead: "provider_error",
    load_week_ahead: "parse_error", weather_medium_range: "parse_error",
  });
  const malformed = db.rows.find(row => row.dataset === "load_week_ahead")!;
  if (malformed.dataset !== "load_week_ahead") throw new Error("Missing week-ahead outcome");
  assertEquals(malformed.result.raw_xml, "<broken>");
});

Deno.test("public weather remains independently archived when ENTSO-E credentials are absent", async () => {
  const db = storage();
  let calls = 0;
  const upstream: typeof fetch = input => {
    assertEquals(new URL(String(input)).hostname, "api.open-meteo.com");
    calls++;
    return Promise.resolve(weather());
  };
  const response = await createMarketArchiveHandler({ ...config, entsoeToken: "" }, db.store, upstream, now)(request());
  assertEquals(response.status, 200);
  assertEquals(calls, 1);
  assertEquals(db.rows.filter(row => "error_code" in row.result && row.result.error_code === "entsoe_token_not_configured").length, 3);
  const captured = db.rows.find(row => row.dataset === "weather_medium_range");
  if (captured?.dataset !== "weather_medium_range") throw new Error("Missing weather");
  assertEquals(captured.result.status, "data");
  assertEquals(captured.result.raw_body, JSON.stringify(mediumRangeWeatherFixture()));
});

Deno.test("weather error outcomes retain the exact request and body without affecting market data", async () => {
  for (const outcome of ["provider", "acknowledgement", "transport", "parse"]) {
    const db = storage();
    const upstream: typeof fetch = input => {
      const url = new URL(String(input));
      if (url.hostname !== "api.open-meteo.com") return Promise.resolve(new Response(hourly));
      if (outcome === "transport") throw new Error(`secret ${config.entsoeToken}`);
      if (outcome === "parse") return Promise.resolve(new Response("broken JSON"));
      return Promise.resolve(Response.json({ error: true, reason: "provider unavailable" }, { status: outcome === "provider" ? 503 : 200 }));
    };
    assertEquals((await createMarketArchiveHandler(config, db.store, upstream, now)(request())).status, 200);
    assertEquals(db.rows.filter(row => row.dataset !== "weather_medium_range" && row.result.status === "data").length, 3);
    const captured = db.rows.find(row => row.dataset === "weather_medium_range");
    if (captured?.dataset !== "weather_medium_range") throw new Error("Missing weather");
    assertEquals(captured.result.status, outcome === "transport" ? "transport_error" : outcome === "parse" ? "parse_error" : "provider_error");
    assertEquals(captured.result.request.provider, "open_meteo");
    assertEquals(captured.result.request.sites.length, 10);
    assertEquals(captured.result.raw_body === null, outcome === "transport");
    assertEquals(JSON.stringify(captured).includes(config.entsoeToken), false);
  }
});

const generationRequest = (body: unknown = { generation: true }) => new Request(`${TEST}/functions/v1/energy-market-archive`, {
  method: "POST", headers: { "x-energy-market-archive-token": "private-cron-token" }, body: JSON.stringify(body),
});
const generationActual = hourly.replace("<businessType>A01</businessType>", '<businessType>A01</businessType><inBiddingZone_Domain.mRID>10Y1001A1001A46L</inBiddingZone_Domain.mRID><MktPSRType><psrType>B14</psrType></MktPSRType>')
  .replaceAll("2026-10-24T22:00Z", "2026-10-24T18:00Z").replaceAll("2026-10-24T23:00Z", "2026-10-24T19:00Z");

Deno.test("generation research acquires 28-day actuals and weather, commits sources before pinning a replayable run", async () => {
  const db = storage();
  const queries: URL[] = [];
  let committed = 0;
  const store: MarketArchiveStore = { ...db.store,
    async saveObservation(row) { await db.store.saveObservation(row); committed++; },
    async saveGenerationRun(run) { assertEquals(committed, 9); await db.store.saveGenerationRun(run); },
  };
  const upstream: typeof fetch = input => {
    const url = new URL(String(input)); queries.push(url);
    return Promise.resolve(url.hostname === "api.open-meteo.com" ? weather() : new Response(url.searchParams.get("documentType") === "A75" ? generationActual : hourly));
  };
  const response = await createMarketArchiveHandler(config, store, upstream, now)(generationRequest());
  assertEquals(response.status, 200);
  assertEquals(db.rows.length, 9);
  assertEquals(db.runs.length, 1);
  const actual = queries.find(url => url.searchParams.get("documentType") === "A75")!;
  assertEquals([actual.searchParams.get("processType"), actual.searchParams.get("psrType"), actual.searchParams.get("periodStart"), actual.searchParams.get("periodEnd")], ["A16", null, "202609262015", "202610242015"]);
  const capturedWeather = db.rows.find(row => row.dataset === "weather_medium_range");
  if (capturedWeather?.dataset !== "weather_medium_range") throw new Error("Missing weather evidence");
  assertEquals(capturedWeather.result.request.past_days, 28);
  assertEquals(capturedWeather.requested_from, "2026-09-26T00:00:00.000Z");
  assertEquals(queries.find(url => url.hostname === "api.open-meteo.com")!.searchParams.get("past_days"), "28");
  const run = db.runs[0];
  assertEquals(run.origin, now().toISOString());
  assertEquals(run.source_refs, Object.fromEntries(db.rows.map(row => [row.dataset, row.id])));
  assertEquals(run.forecast.hours.length, 72);
  assertEquals(run.forecast.hours[0].byPsr.B14.persistence.status, "predicted");
  assertEquals((await response.json()).generation.id, run.id);
});

Deno.test("generation research archives failed current sources without substituting historical data", async () => {
  const db = storage();
  const upstream: typeof fetch = input => {
    const url = new URL(String(input));
    return Promise.resolve(new Response(`unavailable ${config.entsoeToken}`, { status: url.hostname === "api.open-meteo.com" ? 503 : 599 }));
  };
  const response = await createMarketArchiveHandler(config, db.store, upstream, now)(generationRequest());
  assertEquals(response.status, 200);
  assertEquals(db.rows.length, 9);
  assertEquals(db.runs.length, 1);
  assertEquals(db.rows.every(row => row.result.status === "provider_error"), true);
  assertEquals(db.runs[0].source_refs, Object.fromEntries(db.rows.map(row => [row.dataset, row.id])));
  assertEquals(db.runs[0].forecast.hours.every(hour => Object.keys(hour.byPsr).length === 0), true);
  assertEquals(JSON.stringify([db.rows, db.runs]).includes(config.entsoeToken), false);
  assertEquals((await response.json()).generation.predicted, {});
});

Deno.test("generation research reports source storage or run storage failures explicitly", async () => {
  const upstream: typeof fetch = input => Promise.resolve(new URL(String(input)).hostname === "api.open-meteo.com" ? weather() : new Response(generationActual));
  for (const failedStage of ["observation", "run"]) {
    const db = storage();
    const store: MarketArchiveStore = { ...db.store,
      saveObservation: failedStage === "observation" ? () => Promise.reject(new Error("private storage detail")) : db.store.saveObservation,
      saveGenerationRun: failedStage === "run" ? () => Promise.reject(new Error("private storage detail")) : db.store.saveGenerationRun,
    };
    const response = await createMarketArchiveHandler(config, store, upstream, now)(generationRequest());
    assertEquals(response.status, 500);
    assertEquals((await response.json()).error, failedStage === "run" ? "generation_run_storage_failed" : "archive_storage_failed");
    assertEquals(db.runs.length, 0);
  }
});

Deno.test("archive rejects unknown research options before provider access", async () => {
  const db = storage(); let calls = 0;
  const upstream: typeof fetch = () => { calls++; throw new Error("Unexpected provider call"); };
  for (const body of [{ generation: false }, { generation: true, token: "bad" }, [], null]) {
    assertEquals((await createMarketArchiveHandler(config, db.store, upstream, now)(generationRequest(body))).status, 400);
  }
  assertEquals(calls, 0);
  assertEquals(db.runs.length, 0);
});
