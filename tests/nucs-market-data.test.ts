import { assertEquals, assertThrows } from "@std/assert";
import { nucsParameters } from "../supabase/functions/_shared/nucs-market-data.ts";
import { createMarketResearchHandler } from "../supabase/functions/energy-market-research/index.ts";
const query = {
  provider: "nucs",
  dataset: "nucs_week_ahead_ntc",
  neighbour: "SE4",
  direction: "import",
  from: "2026-11-02T00:00:00Z",
  to: "2026-11-09T00:00:00Z",
};
Deno.test("NUCS research parameters exactly match documented capacity and outage requests and reject arbitrary products", () => {
  const ntc = nucsParameters(query);
  assertEquals(Object.fromEntries(ntc), {
    documentType: "A61",
    periodStart: "202611020000",
    periodEnd: "202611090000",
    in_Domain: "10Y1001A1001A46L",
    out_Domain: "10Y1001A1001A47J",
    "contract_MarketAgreement.Type": "A02",
  });
  const outage = nucsParameters({
    ...query,
    dataset: "nucs_transmission_outages",
    direction: "export",
  });
  assertEquals(Object.fromEntries(outage), {
    documentType: "A78",
    periodStart: "202611020000",
    periodEnd: "202611090000",
    in_Domain: "10Y1001A1001A47J",
    out_Domain: "10Y1001A1001A46L",
  });
  assertThrows(() => nucsParameters({ ...query, securityToken: "no" }));
  assertThrows(() => nucsParameters({ ...query, neighbour: "unknown" }));
  assertThrows(() => nucsParameters({ ...query, dataset: "arbitrary" }));
});
Deno.test("NUCS requests use only the server-stored selected token and redact error echoes; the research handler has no database writer", async () => {
  let called = 0;
  const config = {
    projectUrl: "https://vxqpgbzseckgceopitpm.supabase.co",
    secret: "synthetic-private",
    token: "synthetic-entsoe",
    nucsToken: "synthetic-nucs",
  };
  const handler = createMarketResearchHandler(config, (input) => {
    called++;
    const url = new URL(String(input));
    assertEquals(url.origin + url.pathname, "https://www.nucs.net/api");
    assertEquals(url.searchParams.get("securityToken"), "synthetic-nucs");
    return Promise.resolve(
      new Response("failed synthetic-nucs", { status: 400 }),
    );
  });
  const response = await handler(
    new Request("https://example.test", {
      method: "POST",
      headers: { authorization: "Bearer synthetic-private" },
      body: JSON.stringify(query),
    }),
  );
  assertEquals(response.status, 400);
  assertEquals(await response.text(), "failed [REDACTED]");
  assertEquals(called, 1);
});

import {
  captureNucsEvidence,
  parseNucsResponse,
} from "../supabase/functions/_shared/nucs-market-data.ts";
import JSZip from "npm:jszip@3.10.1";
const capacity =
  `<Publication_MarketDocument><mRID>synthetic-capacity</mRID><revisionNumber>1</revisionNumber><type>A61</type><createdDateTime>2026-11-01T00:00Z</createdDateTime><TimeSeries><mRID>1</mRID><businessType>A27</businessType><in_Domain.mRID>10Y1001A1001A46L</in_Domain.mRID><out_Domain.mRID>10Y1001A1001A47J</out_Domain.mRID><quantity_Measure_Unit.name>MAW</quantity_Measure_Unit.name><curveType>A01</curveType><Period><timeInterval><start>2026-11-01T23:00Z</start><end>2026-11-02T23:00Z</end></timeInterval><resolution>P1D</resolution><Point><position>1</position><quantity>1234</quantity></Point></Period></TimeSeries></Publication_MarketDocument>`;
const outage =
  `<Unavailability_MarketDocument><mRID>synthetic-outage</mRID><revisionNumber>3</revisionNumber><type>A78</type><process.processType>A26</process.processType><createdDateTime>2026-11-01T00:00Z</createdDateTime><docStatus><value>A09</value></docStatus><TimeSeries><mRID>synthetic-series</mRID><businessType>A53</businessType><in_Domain.mRID>10Y1001A1001A46L</in_Domain.mRID><out_Domain.mRID>10Y1001A1001A47J</out_Domain.mRID><quantity_Measurement_Unit.name>MAW</quantity_Measurement_Unit.name><curveType>A03</curveType><Available_Period><timeInterval><start>2026-11-02T00:00Z</start><end>2026-11-03T00:00Z</end></timeInterval><resolution>PT1M</resolution><Point><position>1</position><quantity>900</quantity></Point></Available_Period></TimeSeries><Reason><code>A95</code><text>synthetic cancellation</text></Reason></Unavailability_MarketDocument>`;
const nativeQuery = {
  dataset: "nucs_week_ahead_ntc" as const,
  neighbour: "SE4" as const,
  direction: "import" as const,
  from: query.from,
  to: query.to,
};
Deno.test("NUCS archive retains native daily capacity, border orientation, cancelled notices and raw ZIP without summing scenarios", async () => {
  const parsed = await parseNucsResponse(
    new TextEncoder().encode(capacity),
    nativeQuery,
  );
  assertEquals(parsed.status, "data");
  if (parsed.status !== "data") throw new Error("missing capacity");
  assertEquals(parsed.document.capacity_intervals[0].value, 1234);
  assertEquals(parsed.document.capacity_intervals[0].resolution, "P1D");
  const zip = new JSZip();
  zip.file("synthetic.xml", outage);
  const bytes = await zip.generateAsync({ type: "uint8array" });
  const notices = await parseNucsResponse(bytes, {
    ...nativeQuery,
    dataset: "nucs_transmission_outages",
  });
  if (notices.status !== "data") throw new Error("missing notice");
  assertEquals(notices.document.notices[0].status, "A09");
  assertEquals(notices.document.capacity_intervals, []);
  const stored = await captureNucsEvidence(
    { ...nativeQuery, dataset: "nucs_transmission_outages" },
    "synthetic-secret",
    () => Promise.resolve(new Response(new Uint8Array(bytes))),
  );
  assertEquals(stored.status, "data");
  assertEquals(
    Uint8Array.from(atob(stored.raw_base64!), (c) => c.charCodeAt(0)),
    bytes,
  );
});
Deno.test("NUCS no-matching acknowledgements remain absent data even when HTTP is 400", async () => {
  const acknowledgement =
    "<Acknowledgement_MarketDocument><Reason><code>999</code><text>No matching data found for synthetic border</text></Reason></Acknowledgement_MarketDocument>";
  const result = await captureNucsEvidence(
    { ...nativeQuery, dataset: "nucs_transmission_outages" },
    "synthetic-secret",
    () => Promise.resolve(new Response(acknowledgement, { status: 400 })),
  );
  assertEquals(result.status, "no_data");
  assertEquals(result.http_status, 400);
});
