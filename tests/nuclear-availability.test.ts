import { assertEquals, assertRejects, assertStringIncludes } from "@std/assert";
import JSZip from "npm:jszip@3.10.1";
import { computeNuclearAvailability, parseNuclearOutages, parseNuclearRoster, type NuclearOutageDocument, type NuclearOutageNotice, type NuclearRoster } from "../supabase/functions/_shared/nuclear-availability.ts";

const START = Date.parse("2026-10-22T00:00Z");
const HOUR = 3_600_000;
const bytes = (value: string) => new TextEncoder().encode(value);
const names = ["Forsmark block 1", "Forsmark block 2", "Forsmark block 3", "Ringhals 3", "Ringhals 4", "Oskarshamn 3"];
function roster(): NuclearRoster {
  return { units: names.map((name, i) => ({ productionId: `plant-${i}`, name, capacities: [{ startMs: START - HOUR, endMs: START + 100 * HOUR, mw: 1000 }] })) };
}
function notice(overrides: Partial<NuclearOutageNotice> = {}): NuclearOutageNotice {
  return { id: "outage", revision: 1, createdAt: "2026-10-21T12:00:00.000Z", status: null, documentType: "A77",
    productionId: "plant-0", generationId: null, name: names[0], psrType: "B14", nominalMw: 1000, businessType: "A53",
    startMs: START, endMs: START + 3 * HOUR, periods: [{ startMs: START, endMs: START + 3 * HOUR, availableMw: 500 }], ...overrides };
}
function compute(production: NuclearOutageNotice[] = [], generation: NuclearOutageNotice[] = [], installed = roster()) {
  return computeNuclearAvailability({ roster: installed, productionOutages: { documents: production }, generationOutages: { documents: generation } }, START, START + HOUR);
}
const outageXml = (type = "A77", generation = false, points = "<Point><position>1</position><quantity>500</quantity></Point>") => `<Unavailability_MarketDocument>
<mRID>outage</mRID><revisionNumber>2</revisionNumber><type>${type}</type><createdDateTime>2026-10-21T12:00Z</createdDateTime>
<unavailability_Time_Period.timeInterval><start>2026-10-22T00:00Z</start><end>2026-10-22T03:00Z</end></unavailability_Time_Period.timeInterval>
<TimeSeries><businessType>A53</businessType><biddingZone_Domain.mRID>10Y1001A1001A46L</biddingZone_Domain.mRID><quantity_Measure_Unit.name>MAW</quantity_Measure_Unit.name><curveType>A03</curveType>
<production_RegisteredResource.mRID>plant-0</production_RegisteredResource.mRID><production_RegisteredResource.name>Forsmark block 1</production_RegisteredResource.name>
<production_RegisteredResource.pSRType.psrType>B14</production_RegisteredResource.pSRType.psrType>
${generation ? "<production_RegisteredResource.pSRType.powerSystemResources.mRID>generator-1</production_RegisteredResource.pSRType.powerSystemResources.mRID>" : ""}
<production_RegisteredResource.pSRType.powerSystemResources.nominalP unit="MAW">1000</production_RegisteredResource.pSRType.powerSystemResources.nominalP>
<Available_Period><timeInterval><start>2026-10-22T00:00Z</start><end>2026-10-22T03:00Z</end></timeInterval><resolution>PT1M</resolution>${points}</Available_Period>
</TimeSeries></Unavailability_MarketDocument>`;

Deno.test("nuclear outage XML and ZIP preserve available MW, status, native partial steps and identities", async () => {
  const xml = outageXml("A80", true, "<Point><position>1</position><quantity>500</quantity></Point><Point><position>31</position><quantity>800</quantity></Point>");
  const zip = new JSZip(); zip.file("notice.xml", xml);
  const parsed = await parseNuclearOutages(await zip.generateAsync({ type: "uint8array", compression: "DEFLATE" }));
  assertEquals(parsed.documents.length, 1);
  assertEquals(parsed.documents[0].generationId, "generator-1");
  assertEquals(parsed.documents[0].nominalMw, 1000);
  assertEquals(parsed.documents[0].periods, [{ startMs: START, endMs: START + HOUR / 2, availableMw: 500 }, { startMs: START + HOUR / 2, endMs: START + 3 * HOUR, availableMw: 800 }]);
  assertEquals(parsed, await parseNuclearOutages(bytes(xml)));
  const cancelled = await parseNuclearOutages(bytes(xml.replace("<TimeSeries>", "<docStatus><value>A09</value></docStatus><TimeSeries>")));
  assertEquals(cancelled.documents[0].status, "A09");
  const unrepresentable = xml.replace(/<TimeSeries>[\s\S]*<\/TimeSeries>/, "<docStatus><value>A09</value></docStatus>");
  await assertRejects(() => parseNuclearOutages(bytes(unrepresentable)), Error, "cancellation cannot be resolved");
});

Deno.test("nuclear installed roster retains six identities and annual capacities without imposing operator MW", async () => {
  const xml = `<GL_MarketDocument><type>A71</type><process.processType>A33</process.processType>${names.map((name, i) => `<TimeSeries>
  <objectAggregation>A06</objectAggregation><inBiddingZone_Domain.mRID>10Y1001A1001A46L</inBiddingZone_Domain.mRID><registeredResource.mRID>plant-${i}</registeredResource.mRID><registeredResource.name>${name}</registeredResource.name>
  <quantity_Measure_Unit.name>MAW</quantity_Measure_Unit.name><MktPSRType><psrType>B14</psrType></MktPSRType><Period><timeInterval><start>2025-12-31T23:00Z</start><end>2026-12-31T23:00Z</end></timeInterval><resolution>P1Y</resolution><Point><position>1</position><quantity>${900 + i}</quantity></Point></Period></TimeSeries>`).join("")}</GL_MarketDocument>`;
  const parsed = await parseNuclearRoster(bytes(xml));
  assertEquals(parsed.units.length, 6);
  assertEquals(parsed.units[0].capacities[0].mw, 900);
  assertEquals(parsed.units[5].name, "Oskarshamn 3");
  await assertRejects(() => parseNuclearRoster(bytes(xml.replace("<resolution>P1Y</resolution>", "<resolution>P1D</resolution>"))));
  await assertRejects(() => parseNuclearRoster(bytes(xml.replaceAll("2025-12-31T23:00Z", "2026-01-01T00:00Z"))), Error, "January boundaries");
});

Deno.test("nuclear announced availability integrates partial-hour events and avoids parent/child double counting", () => {
  const parent = notice({ periods: [{ startMs: START, endMs: START + HOUR / 2, availableMw: 500 }, { startMs: START + HOUR / 2, endMs: START + 3 * HOUR, availableMw: 800 }] });
  const child = notice({ id: "child", documentType: "A80", generationId: "generator-1", nominalMw: 200,
    periods: [{ startMs: START, endMs: START + 3 * HOUR, availableMw: 0 }] });
  const result = compute([parent], [child]);
  if (result.status !== "data") throw new Error(result.reason);
  assertEquals([result.anchorMw, result.targetMw], [5650, 5800]);
  assertStringIncludes(result.details.assumption, "does not guarantee dispatch");
});

Deno.test("nuclear revisions replace older events, cancellations withdraw them, and identical repeats count once", () => {
  const old = notice(), revised = notice({ revision: 2, periods: [{ startMs: START, endMs: START + 3 * HOUR, availableMw: 200 }] });
  const result = compute([old, revised, revised]);
  if (result.status !== "data") throw new Error(result.reason);
  assertEquals(result.targetMw, 5200);
  assertEquals(result.details.productionNotices, 1);
  for (const status of ["A09", "A13"]) {
    const cancelled = compute([old, notice({ revision: 2, status })]);
    if (cancelled.status !== "data") throw new Error(cancelled.reason);
    assertEquals(cancelled.targetMw, 6000);
  }
});

Deno.test("nuclear missing sources, incomplete roster, unknown units and capacity conflicts are explicit", () => {
  assertEquals(computeNuclearAvailability({ roster: roster(), productionOutages: null, generationOutages: { documents: [] } }, START, START).status, "unavailable");
  assertEquals(compute([], [], { units: roster().units.slice(1) }).status, "unavailable");
  assertEquals(compute([notice({ productionId: "unknown" })]).status, "unavailable");
  assertEquals(compute([notice(), notice({ nominalMw: 999 })]).status, "unavailable");
  assertEquals(compute([notice(), notice({ id: "conflict", periods: [{ startMs: START, endMs: START + 3 * HOUR, availableMw: 400 }] })]).status, "unavailable");
  const conflictingRoster = roster();
  conflictingRoster.units[0].capacities.push({ startMs: START, endMs: START + 3 * HOUR, mw: 1100 });
  assertEquals(compute([], [], conflictingRoster).status, "unavailable");
});

Deno.test("nuclear A01 gaps remain unknown and multiple available periods retain their boundaries", async () => {
  const gapped = await parseNuclearOutages(bytes(outageXml().replace("<curveType>A03", "<curveType>A01")));
  assertEquals(compute(gapped.documents).status, "unavailable");
  const second = `<Available_Period><timeInterval><start>2026-10-22T03:00Z</start><end>2026-10-22T04:00Z</end></timeInterval><resolution>PT60M</resolution><Point><position>1</position><quantity>900</quantity></Point></Available_Period>`;
  const parsed = await parseNuclearOutages(bytes(outageXml().replace("</TimeSeries>", `${second}</TimeSeries>`).replace("<end>2026-10-22T03:00Z</end></unavailability", "<end>2026-10-22T04:00Z</end></unavailability")));
  assertEquals(parsed.documents[0].periods.length, 2);
});

Deno.test("nuclear parser rejects DTD, unsafe or oversized ZIPs and provider document-limit truncation", async () => {
  await assertRejects(() => parseNuclearOutages(bytes(`<!DOCTYPE d [<!ENTITY x 'x'>]>${outageXml()}`)));
  const tooMany = new JSZip();
  for (let i = 0; i < 200; i++) tooMany.file(`${i}.xml`, outageXml());
  await assertRejects(() => tooMany.generateAsync({ type: "uint8array" }).then(parseNuclearOutages), Error, "document limit");
  const huge = new JSZip(); huge.file("huge.xml", "x".repeat(2 * 1024 * 1024 + 1));
  await assertRejects(() => huge.generateAsync({ type: "uint8array", compression: "DEFLATE" }).then(parseNuclearOutages), Error, "oversized");
  await assertRejects(() => parseNuclearOutages(bytes("not XML")), Error, "Malformed");
});

Deno.test("nuclear no-data responses are empty announced-constraint sets and provider errors reject", async () => {
  const ack = (message: string) => bytes(`<Acknowledgement_MarketDocument><Reason><code>999</code><text>${message}</text></Reason></Acknowledgement_MarketDocument>`);
  const empty: NuclearOutageDocument = await parseNuclearOutages(ack("No matching data found"));
  assertEquals(empty.documents, []);
  await assertRejects(() => parseNuclearOutages(ack("Invalid query")), Error, "provider error");
});
