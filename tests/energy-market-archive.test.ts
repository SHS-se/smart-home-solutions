import { assertEquals, assertMatch } from "@std/assert";
import { createMarketArchiveHandler, type MarketArchiveObservation, type MarketArchiveStore } from "../supabase/functions/energy-market-archive/index.ts";

const TEST = "https://vxqpgbzseckgceopitpm.supabase.co";
const config = { projectUrl: TEST, entsoeToken: "private-provider-token", nucsToken: "private-nucs-token" };
const now = () => new Date("2026-10-24T20:15:00.000Z");
const request = (token = "private-cron-token") => new Request(`${TEST}/functions/v1/energy-market-archive`, {
  method: "POST", headers: { "x-energy-market-archive-token": token },
});
const generationRequest = (body: unknown = { generation: true }) => new Request(`${TEST}/functions/v1/energy-market-archive`, {
  method: "POST", headers: { "x-energy-market-archive-token": "private-cron-token" }, body: JSON.stringify(body),
});
const hourly = `<GL_MarketDocument><mRID>doc-1</mRID><revisionNumber>2</revisionNumber><process.processType>A01</process.processType>
<createdDateTime>2026-10-24T08:00Z</createdDateTime><TimeSeries><mRID>series-1</mRID><businessType>A01</businessType><curveType>A01</curveType>
<quantity_Measure_Unit.name>MAW</quantity_Measure_Unit.name><Period><timeInterval><start>2026-10-24T22:00Z</start><end>2026-10-24T23:00Z</end></timeInterval>
<resolution>PT60M</resolution><Point><position>1</position><quantity>1000</quantity></Point></Period></TimeSeries></GL_MarketDocument>`;
function storage() {
  const rows: MarketArchiveObservation[] = [];
  let verified = 0;
  const store: MarketArchiveStore = {
    verifyToken(token) { verified++; return Promise.resolve(token === "private-cron-token"); },
    saveBatch() { return Promise.resolve(); },
    saveObservation(row) { rows.push(row); return Promise.resolve(); },
  };
  return { rows, store, verified: () => verified };
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

Deno.test("hourly market archive requests day-ahead and bounded network datasets and appends repeated observations", async () => {
  const db = storage(), queries: URLSearchParams[] = [];
  const upstream: typeof fetch = (input, init) => {
    const url = new URL(String(input));
    if (url.hostname === 'publicationtool.jao.eu') return Promise.resolve(Response.json({ data: [], rejected: false, messages: null }));
    assertEquals(`${url.origin}${url.pathname}`, "https://web-api.tp.entsoe.eu/api");
    assertEquals(url.searchParams.get("securityToken"), config.entsoeToken);
    assertEquals(init?.redirect, "error");
    queries.push(url.searchParams);
    return Promise.resolve(new Response(hourly));
  };
  const handler = createMarketArchiveHandler(config, db.store, upstream, now);
  assertEquals((await handler(request())).status, 200);
  assertEquals((await handler(request())).status, 200);
  assertEquals(db.rows.length, 12);
  assertEquals(new Set(db.rows.map(row => row.id)).size, 12);
  assertEquals(db.rows.filter(row => row.zone === "SE3").map(row => row.dataset).sort(), ["wind_day_ahead", "load_day_ahead", "wind_day_ahead", "load_day_ahead"].sort());
  assertEquals(queries.slice(0, 2).map(query => [query.get("documentType"), query.get("processType"), query.get("periodStart"), query.get("periodEnd")]), [
    ["A69", "A01", "202610240000", "202610270000"],
    ["A65", "A01", "202610240000", "202610270000"],
  ]);
  for (const row of db.rows.filter(row => row.zone === "SE3")) {
    assertEquals(row.zone, "SE3");
    assertEquals(row.requested_at, now().toISOString());
    assertEquals(row.resolved_at, now().toISOString());
    assertEquals(row.result.status, "data");
    if (!("body_sha256" in row.result)) throw new Error("Unexpected research source in ordinary hourly collection");
    assertMatch(row.result.body_sha256!, /^[a-f0-9]{64}$/);
    if (row.result.status !== "data") throw new Error("Expected data");
    if (!("documentId" in row.result.document)) throw new Error("Unexpected research document in ordinary hourly collection");
    assertEquals(row.result.document.documentId, "doc-1");
    assertEquals(row.result.document.revisionNumber, "2");
  }
  for (const dataset of ["wind_day_ahead", "load_day_ahead"]) {
    const repeated = db.rows.filter(row => row.dataset === dataset);
    assertEquals(repeated.length, 2);
    const first = repeated[0].result, second = repeated[1].result;
    if (!("body_sha256" in first) || !("body_sha256" in second)) throw new Error("Unexpected research source");
    assertEquals(first.body_sha256, second.body_sha256);
  }
});

Deno.test("hourly market archive fetches both datasets concurrently and waits for partial storage failures", async () => {
  const db = storage();
  let entered = 0;
  let allEntered: () => void = () => {};
  const ready = new Promise<void>(resolve => { allEntered = resolve; });
  const upstream: typeof fetch = async input => {
    if (new URL(String(input)).hostname === 'publicationtool.jao.eu') return Response.json({ data: [], rejected: false, messages: null });
    entered++;
    if (entered === 2) allEntered();
    await ready;
    return new Response(hourly);
  };
  const store: MarketArchiveStore = { ...db.store, saveObservation(row, assessment) {
    if (row.dataset === "load_day_ahead") return Promise.reject(new Error("private db detail"));
    return db.store.saveObservation(row, assessment);
  } };
  const response = await createMarketArchiveHandler(config, store, upstream, now)(request());
  assertEquals(response.status, 500);
  const body = await response.json();
  assertEquals(body.error, "archive_storage_failed");
  assertEquals(body.observations.length, 5);
  assertEquals(db.rows.length, 5);
});

Deno.test("market archive preserves no-data and provider failures while concealing credentials", async () => {
  const db = storage();
  const upstream: typeof fetch = input => {
    const url = new URL(String(input));
    if (url.searchParams.get("documentType") === "A69") return Promise.resolve(new Response(`<Acknowledgement_MarketDocument><Reason><code>999</code><text>No matching data found</text></Reason></Acknowledgement_MarketDocument>`));
    if (url.searchParams.get("processType") === "A01") return Promise.resolve(new Response(`upstream ${config.entsoeToken} ${encodeURIComponent(config.entsoeToken)}`, { status: 599 }));
    throw new Error(`connection failed ${url}`);
  };
  const response = await createMarketArchiveHandler(config, db.store, upstream, now)(generationRequest());
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
  const response = await createMarketArchiveHandler(config, db.store, upstream, now)(generationRequest());
  assertEquals(response.status, 200);
  assertEquals(Object.fromEntries(db.rows.filter(row => ["wind_day_ahead", "load_day_ahead", "load_week_ahead"].includes(row.dataset)).map(row => [row.dataset, row.result.status])), {
    wind_day_ahead: "provider_error", load_day_ahead: "provider_error",
    load_week_ahead: "parse_error",
  });
  const malformed = db.rows.find(row => row.dataset === "load_week_ahead")!;
  if (malformed.dataset !== "load_week_ahead") throw new Error("Missing week-ahead outcome");
  assertEquals(malformed.result.raw_xml, "<broken>");
});

Deno.test("generation collection keeps actual market data without a weather API call", async () => {
  const db = storage(), queries: URL[] = [];
  const upstream: typeof fetch = input => {
    const url = new URL(String(input)); queries.push(url);
    assertEquals(url.hostname, "web-api.tp.entsoe.eu");
    return Promise.resolve(new Response(hourly));
  };
  const response = await createMarketArchiveHandler(config, db.store, upstream, now)(generationRequest());
  assertEquals(response.status, 200);
  assertEquals(db.rows.length, 8);
  const actual = queries.find(url => url.searchParams.get("documentType") === "A75")!;
  assertEquals([actual.searchParams.get("processType"), actual.searchParams.get("periodStart"), actual.searchParams.get("periodEnd")],
    ["A16", "202609262015", "202610242015"]);
  assertEquals((await response.json()).observations.length, 8);
});

Deno.test("archive rejects unknown research options before provider access", async () => {
  const db = storage(); let calls = 0;
  const upstream: typeof fetch = () => { calls++; throw new Error("Unexpected provider call"); };
  for (const body of [{ generation: false }, { generation: true, token: "bad" }, [], null]) {
    assertEquals((await createMarketArchiveHandler(config, db.store, upstream, now)(generationRequest(body))).status, 400);
  }
  assertEquals(calls, 0);
});

Deno.test('context collection commits intent first and independently archives actual demand and all five neighbouring areas', async () => {
  const db = storage(), queries: URL[] = [];
  let intentSaved = false;
  const store: MarketArchiveStore = { ...db.store,
    saveBatch(batch) { assertEquals(batch.kind, 'market_context'); assertEquals(batch.plan.length, 11); intentSaved = true; return Promise.resolve(); },
  };
  const upstream: typeof fetch = input => {
    assertEquals(intentSaved, true);
    const url = new URL(String(input)); queries.push(url);
    return Promise.resolve(new Response(hourly));
  };
  const response = await createMarketArchiveHandler(config, store, upstream, now)(generationRequest({ context: true }));
  assertEquals(response.status, 200);
  assertEquals(db.rows.length, 11);
  const actual = queries.find(q => q.searchParams.get('processType') === 'A16')!;
  assertEquals(actual.searchParams.get('outBiddingZone_Domain'), '10Y1001A1001A46L');
  assertEquals(actual.searchParams.get('periodStart'), '202609262015');
  assertEquals(queries.filter(q => q.searchParams.get('processType') === 'A01').length, 10);
  assertEquals(new Set(queries.filter(q => q.searchParams.get('processType') === 'A01').map(q => q.searchParams.get('outBiddingZone_Domain') ?? q.searchParams.get('in_Domain'))).size, 5);
  assertEquals(db.rows.some(r => r.zone !== 'SE3' && !r.dataset.startsWith('neighbour_')), false);
});
Deno.test('failed intent storage prevents untracked provider acquisition', async () => {
  const db = storage(); let calls = 0;
  const store: MarketArchiveStore = { ...db.store, saveBatch() { return Promise.reject(new Error('private storage detail')); } };
  const upstream: typeof fetch = () => { calls++; throw new Error('unexpected'); };
  const response = await createMarketArchiveHandler(config, store, upstream, now)(request());
  assertEquals(response.status, 500);
  assertEquals(calls, 0);
  assertEquals(await response.json(), { error: 'archive_batch_storage_failed' });
});
Deno.test('public network data remains independent of missing ENTSO-E credentials and preserves provider rejections', async () => {
  const db = storage();
  const upstream: typeof fetch = input => {
    const url = new URL(String(input));
    assertEquals(url.hostname, 'publicationtool.jao.eu');
    assertEquals(url.searchParams.get('securityToken'), null);
    return Promise.resolve(Response.json({ data: [], rejected: url.pathname.endsWith('maxNetPos'), messages: ['synthetic rejection'] }));
  };
  assertEquals((await createMarketArchiveHandler({ ...config, entsoeToken: '' }, db.store, upstream, now)(request())).status, 200);
  assertEquals(db.rows.filter(r => r.dataset === 'jao_max_net_positions').every(r => r.result.status === 'provider_error'), true);
  assertEquals(db.rows.filter(r => r.dataset === 'jao_max_exchanges').every(r => r.result.status === 'no_data'), true);
});
