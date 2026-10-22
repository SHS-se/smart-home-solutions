import { assertEquals, assertThrows } from "@std/assert";
import { entsoeParameters, parseEntsoeResponse } from "../supabase/functions/_shared/entsoe-market-data.ts";
import { createMarketResearchHandler } from "../supabase/functions/energy-market-research/index.ts";

const FROM = "2026-10-20T00:00:00.000Z", TO = "2026-10-21T00:00:00.000Z";
const query = { dataset: "load_actual", from: FROM, to: TO };
const document = (curve: string, resolution: string, points: string) => `<?xml version="1.0"?>
<ns:GL_MarketDocument xmlns:ns="urn:entsoe:test">
<ns:createdDateTime>2026-10-22T12:00:00Z</ns:createdDateTime>
<ns:TimeSeries><ns:curveType>${curve}</ns:curveType><ns:quantity_Measure_Unit.name>MAW</ns:quantity_Measure_Unit.name>
<ns:MktPSRType><ns:psrType>B19</ns:psrType></ns:MktPSRType><ns:Period>
<ns:timeInterval><ns:start>2026-10-20T00:00Z</ns:start><ns:end>2026-10-20T01:00Z</ns:end></ns:timeInterval>
<ns:resolution>${resolution}</ns:resolution>${points}</ns:Period></ns:TimeSeries></ns:GL_MarketDocument>`;
const point = (position: number, quantity: number) => `<ns:Point><ns:position>${position}</ns:position><ns:quantity>${quantity}</ns:quantity></ns:Point>`;

Deno.test("ENTSO-E closed queries fix SE3 and known dataset parameters", () => {
  assertEquals(Object.fromEntries(entsoeParameters(query)), {
    documentType: "A65", processType: "A16", outBiddingZone_Domain: "10Y1001A1001A46L",
    periodStart: "202610200000", periodEnd: "202610210000",
  });
  assertEquals(entsoeParameters({ ...query, dataset: "load_week_ahead" }).get("processType"), "A31");
  assertEquals(entsoeParameters({ ...query, dataset: "nuclear_actual" }).get("psrType"), "B14");
  for (const invalid of [null, [], { ...query, dataset: "__proto__" }, { ...query, dataset: "transmission_outages" }, { ...query, securityToken: "bad" },
    { ...query, from: "2026-02-30T00:00:00Z" }, { ...query, from: "2026-10-20" },
    { ...query, to: FROM }, { ...query, to: "2026-10-21T00:00:01Z" }]) {
    assertThrows(() => entsoeParameters(invalid));
  }
});

Deno.test("ENTSO-E A01 keeps missing quarter positions as gaps and source metadata", () => {
  const result = parseEntsoeResponse(document("A01", "PT15M", point(1, 12) + point(3, 18)));
  assertEquals(result.status, "data");
  if (result.status !== "data") throw new Error("Expected data");
  assertEquals(result.createdAt, "2026-10-22T12:00:00Z");
  assertEquals([result.documentId, result.revisionNumber, result.processType], [null, null, null]);
  assertEquals(result.intervals, [
    { startMs: Date.parse(FROM), endMs: Date.parse(FROM) + 900_000, value: 12, unit: "MAW", psrType: "B19", resolution: "PT15M", businessType: null, seriesId: null, flow: null },
    { startMs: Date.parse(FROM) + 1_800_000, endMs: Date.parse(FROM) + 2_700_000, value: 18, unit: "MAW", psrType: "B19", resolution: "PT15M", businessType: null, seriesId: null, flow: null },
  ]);
});

Deno.test("ENTSO-E P1D keeps A60/A61 daily min/max and document provenance", () => {
  const xml = `<GL_MarketDocument xmlns="urn:entsoe:test"><mRID>source-document</mRID><revisionNumber>7</revisionNumber>
  <process.processType>A31</process.processType><createdDateTime>2026-10-20T08:15:00Z</createdDateTime>
  ${["A60", "A61"].map((business, index) => `<TimeSeries><mRID>series-${index}</mRID><businessType>${business}</businessType>
  <curveType>A01</curveType><quantity_Measure_Unit.name>MAW</quantity_Measure_Unit.name><Period>
  <timeInterval><start>2026-10-24T22:00Z</start><end>2026-10-26T23:00Z</end></timeInterval>
  <resolution>P1D</resolution><Point><position>1</position><quantity>${5000 + index * 3000}</quantity></Point>
  <Point><position>2</position><quantity>${5500 + index * 3000}</quantity></Point></Period></TimeSeries>`).join("")}</GL_MarketDocument>`;
  const result = parseEntsoeResponse(xml);
  if (result.status !== "data") throw new Error("Expected daily range data");
  assertEquals([result.documentId, result.revisionNumber, result.processType], ["source-document", "7", "A31"]);
  assertEquals(result.intervals.length, 4);
  assertEquals(result.intervals.map(row => [row.resolution, row.businessType, row.seriesId, (row.endMs - row.startMs) / 3_600_000]), [
    ["P1D", "A60", "series-0", 25], ["P1D", "A60", "series-0", 24],
    ["P1D", "A61", "series-1", 25], ["P1D", "A61", "series-1", 24],
  ]);
  assertEquals(result.intervals.map(row => row.value), [5000, 5500, 8000, 8500]);
  assertThrows(() => parseEntsoeResponse(xml.replaceAll("2026-10-24T22:00Z", "2026-10-24T21:00Z")), Error, "expected SE3 midnight");
});

Deno.test("ENTSO-E P1D explicit end clamps a short calendar day while retaining gaps", () => {
  const xml = `<GL_MarketDocument><TimeSeries><curveType>A01</curveType><businessType>A60</businessType>
  <quantity_Measure_Unit.name>MAW</quantity_Measure_Unit.name><Period>
  <timeInterval><start>2026-03-28T23:00Z</start><end>2026-03-30T22:00Z</end></timeInterval><resolution>P1D</resolution>
  <Point><position>1</position><quantity>1</quantity></Point></Period></TimeSeries></GL_MarketDocument>`;
  const result = parseEntsoeResponse(xml);
  if (result.status !== "data") throw new Error("Expected data");
  assertEquals(result.intervals.length, 1);
  assertEquals((result.intervals[0].endMs - result.intervals[0].startMs) / 3_600_000, 23);
  const clamped = parseEntsoeResponse(xml.replace("2026-03-30T22:00Z", "2026-03-29T21:00Z"));
  if (clamped.status !== "data") throw new Error("Expected data");
  assertEquals(clamped.intervals[0].endMs, Date.parse("2026-03-29T21:00Z"));
});

Deno.test("ENTSO-E A03 holds each block until the next position or period end", () => {
  const result = parseEntsoeResponse(document("A03", "PT15M", point(1, 12) + point(3, 18)));
  if (result.status !== "data") throw new Error("Expected data");
  assertEquals(result.intervals.map(p => p.endMs - p.startMs), [1_800_000, 1_800_000]);
  const hourly = parseEntsoeResponse(document("A03", "PT60M", point(1, 5)));
  if (hourly.status !== "data") throw new Error("Expected data");
  assertEquals(hourly.intervals[0].endMs - hourly.intervals[0].startMs, 3_600_000);
});

Deno.test("ENTSO-E price units and negative prices are retained", () => {
  const xml = document("A01", "PT60M", point(1, -5)).replaceAll("quantity_Measure_Unit.name", "price_Measure_Unit.name")
    .replaceAll("MAW", "MWH").replaceAll("ns:quantity", "ns:price.amount");
  const result = parseEntsoeResponse(xml);
  if (result.status !== "data") throw new Error("Expected data");
  assertEquals(result.intervals[0].value, -5);
  assertEquals(result.intervals[0].unit, "MWH");
});

Deno.test("ENTSO-E no-data acknowledgement differs from provider errors", () => {
  const ack = (code: string, reason: string) => `<Acknowledgement_MarketDocument><Reason><code>${code}</code><text>${reason}</text></Reason></Acknowledgement_MarketDocument>`;
  assertEquals(parseEntsoeResponse(ack("999", "No matching data found for query")), { status: "no_data", reason: "No matching data found for query" });
  assertThrows(() => parseEntsoeResponse(ack("999", "Invalid query")), Error, "acknowledgement");
  assertThrows(() => parseEntsoeResponse("PK compressed outage archive"), Error, "unsupported");
  assertThrows(() => parseEntsoeResponse("<document><unclosed></document>"), Error, "Malformed");
  assertThrows(() => parseEntsoeResponse(document("A01", "PT30M", point(1, 2))), Error, "resolution");
  assertThrows(() => parseEntsoeResponse(document("A01", "PT15M", point(1, 2) + point(1, 3))), Error, "Duplicate");
  assertThrows(() => parseEntsoeResponse(document("A01", "PT15M", point(5, 2))), Error, "position");
});

const TEST = "https://vxqpgbzseckgceopitpm.supabase.co";
const config = { projectUrl: TEST, secret: "private-test-secret", token: "server-token" };
const request = (body: unknown = query, auth = "Bearer private-test-secret") => new Request(`${TEST}/functions/v1/energy-market-research`, {
  method: "POST", headers: { authorization: auth }, body: JSON.stringify(body),
});

Deno.test("market research never contacts provider outside TEST or without private auth", async () => {
  let calls = 0;
  const upstream: typeof fetch = () => { calls++; return Promise.resolve(new Response("provider")); };
  assertEquals((await createMarketResearchHandler({ ...config, projectUrl: "https://oosxndduqzhvrorgogaw.supabase.co" }, upstream)(request())).status, 403);
  assertEquals((await createMarketResearchHandler(config, upstream)(request(query, "Bearer wrong"))).status, 401);
  assertEquals((await createMarketResearchHandler(config, upstream)(request({ ...query, securityToken: "bad" }))).status, 400);
  assertEquals(calls, 0);
});

Deno.test("market research preserves raw upstream status and bytes with the token confined to the request", async () => {
  const upstream: typeof fetch = (input, options) => {
    const url = new URL(String(input));
    assertEquals(url.origin + url.pathname, "https://web-api.tp.entsoe.eu/api");
    assertEquals(url.searchParams.get("securityToken"), "server-token");
    assertEquals(options?.redirect, "error");
    return Promise.resolve(new Response("upstream timeout evidence", { status: 599, headers: { "content-type": "text/plain" } }));
  };
  const response = await createMarketResearchHandler(config, upstream)(request());
  assertEquals(response.status, 599);
  assertEquals(response.headers.get("content-type"), "text/plain");
  assertEquals(await response.text(), "upstream timeout evidence");
  assertEquals(response.headers.get("cache-control"), "no-store");
});

Deno.test("market research does not expose credential-bearing transport errors", async () => {
  const upstream: typeof fetch = () => { throw new Error("network failure https://upstream?securityToken=server-token"); };
  const response = await createMarketResearchHandler(config, upstream)(request());
  assertEquals(response.status, 502);
  assertEquals(await response.json(), { error: "entsoe_transport_failed" });
});

Deno.test("ENTSO-E explicit generation query retains production and consumption directions", () => {
  const params = entsoeParameters({ ...query, dataset: "generation_actual" });
  assertEquals([params.get("documentType"), params.get("processType"), params.get("psrType")], ["A75", "A16", null]);
  const xml = document("A01", "PT60M", point(1, 9));
  const annotate = (fields: string) => xml.replace("<ns:curveType>", `${fields}<ns:curveType>`);
  const flow = (fields: string) => {
    const response = parseEntsoeResponse(annotate(fields));
    if (response.status !== "data") throw new Error("Expected generation data");
    return response.intervals[0].flow;
  };
  assertEquals(flow('<ns:inBiddingZone_Domain.mRID>SE3</ns:inBiddingZone_Domain.mRID><ns:businessType>A01</ns:businessType>'), "production");
  assertEquals(flow('<ns:outBiddingZone_Domain.mRID>SE3</ns:outBiddingZone_Domain.mRID><ns:businessType>A04</ns:businessType>'), "consumption");
  assertEquals(flow('<ns:businessType>A01</ns:businessType>'), "production");
  assertEquals(flow(''), null);
  assertThrows(() => flow('<ns:outBiddingZone_Domain.mRID>SE3</ns:outBiddingZone_Domain.mRID><ns:businessType>A01</ns:businessType>'), Error, "Inconsistent");
  assertThrows(() => flow('<ns:outBiddingZone_Domain.mRID>SE3</ns:outBiddingZone_Domain.mRID><ns:inBiddingZone_Domain.mRID>SE3</ns:inBiddingZone_Domain.mRID>'), Error, "Ambiguous");
});

Deno.test('capacity research queries distinguish production notices and annual installed-unit metadata', () => {
  const from = '2026-01-01T00:00:00Z', to = '2027-01-01T00:00:00Z';
  const production = entsoeParameters({ dataset: 'production_outages', from, to });
  assertEquals(production.get('documentType'), 'A77');
  assertEquals(production.get('biddingZone_Domain'), '10Y1001A1001A46L');
  const roster = entsoeParameters({ dataset: 'installed_generation_units', from, to });
  assertEquals(roster.get('documentType'), 'A71');
  assertEquals(roster.get('processType'), 'A33');
  assertEquals(roster.get('in_Domain'), '10Y1001A1001A46L');
});
