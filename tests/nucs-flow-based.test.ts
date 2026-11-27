import {
  marketZipDirectory,
  marketZipMemberBytes,
} from "../supabase/functions/_shared/market-xml.ts";
/** Independently authored synthetic NUCS publications. No measured or household data. */
import { assert, assertEquals, assertRejects, assertThrows } from "@std/assert";
import JSZip from "npm:jszip@3.10.1";
import {
  captureNucsFlowEvidence,
  type NucsFlowDataset,
  nucsFlowParameters,
  parseNucsFlowXml,
} from "../supabase/functions/_shared/nucs-flow-based.ts";
import {
  type NucsDomainRecord,
  streamNucsDomain,
} from "../supabase/functions/_shared/nucs-domain-reader.ts";
import {
  collectionPlan,
  parseCollectionRequest,
} from "../supabase/functions/_shared/market-collection-plan.ts";
import { assessMarketObservation } from "../supabase/functions/_shared/market-evidence-assessment.ts";
import { marketFoundationDb } from "./helpers/market-foundation-db.ts";
import {
  createMarketArchiveHandler,
  type MarketArchiveObservation,
} from "../supabase/functions/energy-market-archive/index.ts";

const from = "2026-11-28T00:00:00Z", to = "2026-11-28T03:00:00Z";
const query = (dataset: NucsFlowDataset = "nucs_week_ahead_available") => ({
  dataset,
  from,
  to,
});
const header = (type: string, id: string) =>
  "<mRID>" + id + "</mRID><revisionNumber>2</revisionNumber><type>" + type +
  "</type><process.processType>A31</process.processType><createdDateTime>2026-11-27T12:00Z</createdDateTime><docStatus><value>A36</value></docStatus>";
const positionXml = (available: boolean) => {
  const root = available
    ? "Unavailability_MarketDocument"
    : "Capacity_MarketDocument";
  const period = available ? "Available_Period" : "Period";
  const unit = available
    ? "quantity_Measurement_Unit.name"
    : "measurement_Unit.name";
  return "<" + root + ">" +
    header(available ? "A78" : "B31", "synthetic-available") +
    ["import", "export"].map((direction) =>
      "<TimeSeries><mRID>synthetic-" + direction + "</mRID><businessType>" +
      (available ? "A53" : direction === "import" ? "B69" : "B70") +
      "</businessType><in_Domain.mRID>" +
      (direction === "import" ? "10Y1001A1001A46L" : "10Y1001A1001A91G") +
      "</in_Domain.mRID><out_Domain.mRID>" +
      (direction === "import" ? "10Y1001A1001A91G" : "10Y1001A1001A46L") +
      "</out_Domain.mRID><" + unit + ">MAW</" + unit +
      "><curveType>A03</curveType><" + period +
      "><timeInterval><start>" + from + "</start><end>" + to +
      "</end></timeInterval><resolution>PT1M</resolution><Point><position>1</position><quantity>-321</quantity></Point><Point><position>61</position><quantity>0</quantity></Point></" +
      period + "></TimeSeries>"
    ).join("") +
    "</" + root + ">";
};
const constraint =
  "<Constraint_Series><mRID>synthetic-cnec</mRID><businessType>B40</businessType><quantity_Measurement_Unit.name>MAW</quantity_Measurement_Unit.name><Monitored_Series><mRID>synthetic-monitored</mRID><RegisteredResource><mRID>synthetic-resource</mRID><flowBasedStudy_Domain.flowBasedMargin_Quantity.quantity>-12.5</flowBasedStudy_Domain.flowBasedMargin_Quantity.quantity><PTDF_Domain><mRID>10Y1001A1001A46L</mRID><pTDF_Quantity.quantity>0</pTDF_Quantity.quantity></PTDF_Domain><PTDF_Domain><mRID>10Y1001A1001A45N</mRID><pTDF_Quantity.quantity>-0.25</pTDF_Quantity.quantity></PTDF_Domain></RegisteredResource></Monitored_Series></Constraint_Series>";
const domainXml = "<CriticalNetworkElement_MarketDocument>" +
  header("B11", "synthetic-domain") +
  "<Related_MarketDocument><mRID>synthetic-available</mRID><revisionNumber>2</revisionNumber></Related_MarketDocument>" +
  "<TimeSeries><mRID>synthetic-series</mRID><businessType>B38</businessType><curveType>A03</curveType><Period><timeInterval><start>" +
  from + "</start><end>" + to +
  "</end></timeInterval><resolution>PT60M</resolution><Point><position>1</position>" +
  constraint +
  "</Point></Period><Reason><code>A95</code><text>synthetic-asset</text></Reason></TimeSeries></CriticalNetworkElement_MarketDocument>";

async function bundle(xml = domainXml) {
  const inner = new JSZip();
  inner.file("synthetic-domain.xml", xml);
  const outer = new JSZip();
  outer.file(
    "synthetic-domain.zip",
    await inner.generateAsync({ type: "uint8array", compression: "DEFLATE" }),
  );
  outer.file("synthetic-available.xml", positionXml(true));
  outer.file("synthetic-unavailable.xml", positionXml(false));
  return outer.generateAsync({ type: "uint8array", compression: "DEFLATE" });
}
Deno.test("NUCS closed flow-based queries distinguish horizons, linked domains and native net positions", () => {
  for (const horizon of ["week", "month"] as const) {
    const dataset = ("nucs_" + horizon + "_ahead_available") as NucsFlowDataset;
    const parameters = nucsFlowParameters({
      provider: "nucs",
      ...query(dataset),
    });
    assertEquals(parameters.get("documentType"), "A78");
    assertEquals(
      parameters.get("processType"),
      horizon === "week" ? "A31" : "A32",
    );
    assertEquals(parameters.get("fbForecast"), "true");
  }
  const parameters = nucsFlowParameters({
    provider: "nucs",
    ...query("nucs_month_ahead_domain"),
    publication_id: "synthetic-available",
    publication_revision: "2",
  });
  assertEquals(Object.fromEntries(parameters), {
    mRID: "synthetic-available",
    documentVersion: "2",
    fbBatch: "true",
  });
  assertThrows(() =>
    nucsFlowParameters({
      provider: "nucs",
      ...query(),
      publication_id: "synthetic",
      publication_revision: "2",
    })
  );
  assertThrows(() =>
    nucsFlowParameters({
      provider: "nucs",
      ...query(),
      securityToken: "synthetic",
    })
  );
  assertEquals(
    parseCollectionRequest('{"flowBased":"month"}').kind,
    "nucs_month_context",
  );
  for (const day of ["2026-03-28", "2026-10-24", "2026-12-31"]) {
    for (const kind of ["nucs_week_context", "nucs_month_context"] as const) {
      const plan = collectionPlan(kind, new Date(day + "T12:00Z"));
      assertEquals(plan.length, 3);
      assert(plan[0].dataset.endsWith("_available"));
      assert(plan[2].dataset.endsWith("_domain"));
      for (const item of plan) {
        nucsFlowParameters({
          provider: "nucs",
          dataset: item.dataset,
          from: item.from,
          to: item.to,
        });
      }
    }
  }
});
Deno.test("NUCS sparse native signed net positions retain zero, missing lead coverage, revisions and cancellations", () => {
  const document = parseNucsFlowXml(positionXml(true), query())!;
  if (!("positions" in document)) throw new Error("Expected positions");
  assertEquals(document.positions.map((p) => p.value_mw), [-321, 0, -321, 0]);
  assertEquals(document.positions[0].end, "2026-11-28T01:00:00.000Z");
  assertEquals(document.positions[1].end, "2026-11-28T03:00:00.000Z");
  assertEquals(document.status, "A36");
  assertEquals(
    parseNucsFlowXml(positionXml(true).replace("A36", "A09"), query())!.status,
    "A09",
  );
  assertThrows(() =>
    parseNucsFlowXml(positionXml(true).replace("A31", "A32"), query())
  );
  assertThrows(() =>
    parseNucsFlowXml(
      positionXml(false).replace("B69", "B70"),
      query("nucs_week_ahead_unavailable"),
    )
  );
});
Deno.test("NUCS domains archive immutable compressed bytes and stream full constraints with bounded memory", async () => {
  const bytes = await bundle();
  const saved: Uint8Array[] = [];
  const available = await captureNucsFlowEvidence(
    query(),
    "synthetic-token",
    async () => {},
    null,
    () => Promise.resolve(new Response(positionXml(true))),
  );
  const evidence = await captureNucsFlowEvidence(
    query("nucs_week_ahead_domain"),
    "synthetic-token",
    (_path, value) => {
      saved.push(value);
      return Promise.resolve();
    },
    { id: "synthetic-source-id", evidence: available },
    (input) => {
      const params = new URL(String(input)).searchParams;
      assertEquals(params.get("fbBatch"), "true");
      return Promise.resolve(new Response(new Uint8Array(bytes)));
    },
  );
  assertEquals(evidence.status, "data");
  assertEquals(saved, [bytes]);
  assertEquals(evidence.raw_base64, null);
  if (
    evidence.status !== "data" ||
    !("source_observation_id" in evidence.document)
  ) throw new Error("Expected archive");
  const publication = evidence.document.publications[0];
  const records: NucsDomainRecord[] = [];
  for await (
    const record of streamNucsDomain(bytes, publication, { from, to })
  ) records.push(record);
  assertEquals(records.length, 2);
  if (records[0].kind !== "constraint") throw new Error("Expected constraint");
  assertEquals(records[0].constraint.monitored[0].ram_mw, -12.5);
  assertEquals(records[0].constraint.monitored[0].ptdf, {
    "10Y1001A1001A46L": 0,
    "10Y1001A1001A45N": -0.25,
  });
  const wrong = { ...publication, revision: "3" };
  await assertRejects(async () => {
    for await (
      const _record of streamNucsDomain(bytes, wrong, { from, to })
    ) { /* consume validation */ }
  });
  const malformed = await bundle(
    domainXml.replace("</CriticalNetworkElement_MarketDocument>", ""),
  );
  await assertRejects(async () => {
    for await (
      const _record of streamNucsDomain(malformed, publication, { from, to })
    ) { /* consume validation */ }
  });
});
Deno.test("NUCS collector commits net positions before fetching their linked domain, retaining failures explicitly", async () => {
  const bytes = await bundle();
  const rows: MarketArchiveObservation[] = [];
  let batch:
    import("../supabase/functions/_shared/market-collection-plan.ts").MarketBatch;
  const queued: string[] = [];
  const handler = createMarketArchiveHandler({
    projectUrl: "https://vxqpgbzseckgceopitpm.supabase.co",
    entsoeToken: "",
    nucsToken: "synthetic-nucs-secret",
  }, {
    verifyToken: () => Promise.resolve(true),
    saveBatch: (value) => {
      batch = value;
      return Promise.resolve();
    },
    queueNucsProduct: (_batchId, key) => {
      queued.push(key);
      return Promise.resolve();
    },
    loadNucsProduct: (_batchId, _key) =>
      Promise.resolve({
        batch,
        available: rows[0]
          ? {
            id: rows[0].id,
            evidence: rows[0]
              .result as import("../supabase/functions/_shared/nucs-flow-based.ts").NucsFlowEvidence,
          }
          : null,
      }),
    saveNative: () => Promise.resolve(),
    saveObservation: (row) => {
      rows.push(row);
      return Promise.resolve();
    },
  }, (input) => {
    const params = new URL(String(input)).searchParams;
    if (params.has("fbBatch")) {
      assertEquals(rows.length, 2);
      return Promise.resolve(new Response(new Uint8Array(bytes)));
    }
    return Promise.resolve(
      new Response(positionXml(params.get("documentType") === "A78")),
    );
  }, () => new Date("2026-11-27T12:00Z"));
  const response = await handler(
    new Request("https://example.test", {
      method: "POST",
      headers: { "x-energy-market-archive-token": "synthetic" },
      body: '{"flowBased":"week"}',
    }),
  );
  assertEquals(response.status, 202, JSON.stringify(await response.json()));
  assertEquals(queued.length, 2);
  while (queued.length) {
    const result = await handler(
      new Request("https://example.test", {
        method: "POST",
        headers: { "x-energy-market-archive-token": "synthetic" },
        body: JSON.stringify({
          nucsProduct: { batch_id: batch!.id, request_key: queued.shift()! },
        }),
      }),
    );
    assertEquals(result.status, 200, JSON.stringify(await result.json()));
  }
  assertEquals(rows.map((r) => r.dataset), [
    "nucs_week_ahead_available",
    "nucs_week_ahead_unavailable",
    "nucs_week_ahead_domain",
  ]);
});
Deno.test("NUCS experiment context freezes exact latest attempts and enforces archive, intent and service access", async () => {
  const db = await marketFoundationDb();
  try {
    await db.exec(
      "CREATE SCHEMA storage; CREATE TABLE storage.buckets(id text PRIMARY KEY,name text,public boolean,file_size_limit bigint,allowed_mime_types text[]); CREATE TABLE storage.objects(bucket_id text,name text);",
    );
    for (
      const migration of [
        "20261101143000_retire_test_price_workers",
        "20261101144000_market_data_foundation",
        "20261101162000_weather_accuracy_quality_monitor",
        "20261101164000_verified_regional_context",
        "20261101180000_retrospective_regional_backfill",
        "20261101181000_native_history_request_windows",
        "20261113134000_se3_market_history",
        "20261113205000_test_se3_net_import_forecast",
      ]
    ) {
      await db.exec(
        await Deno.readTextFile("supabase/migrations/" + migration + ".sql"),
      );
    }
    await db.exec("SELECT private.enable_test_market_archive()");
    await db.exec(
      await Deno.readTextFile(
        "supabase/migrations/20261127170000_test_nucs_flow_based.sql",
      ),
    );
    await db.exec(
      await Deno.readTextFile(
        "supabase/migrations/20261127173000_test_nucs_product_workers.sql",
      ),
    );
    await db.exec(
      await Deno.readTextFile(
        "supabase/migrations/20261127173100_test_nucs_product_identity.sql",
      ),
    );
    await db.exec(
      await Deno.readTextFile(
        "supabase/migrations/20261127180000_test_nucs_domain_workers.sql",
      ),
    );
    await db.exec(
      "CREATE TABLE net.calls(url text); CREATE OR REPLACE FUNCTION net.http_post(url text,headers jsonb,body jsonb,timeout_milliseconds integer) RETURNS bigint LANGUAGE sql AS $$ WITH saved AS (INSERT INTO net.calls VALUES($1)) SELECT 1::bigint $$",
    );
    const plan = collectionPlan(
      "nucs_week_context",
      new Date("2026-11-27T12:00Z"),
    );
    const batchId = crypto.randomUUID();
    await db.query(
      "INSERT INTO energy_market_collection_batches(id,kind,requested_at,plan) VALUES($1,'nucs_week_context','2026-11-27T12:00Z',$2)",
      [batchId, plan],
    );
    const item = plan[0], id = crypto.randomUUID();
    await db.query("SELECT public.request_test_nucs_product($1,$2)", [
      batchId,
      item.key,
    ]);
    const job = await db.query<
      { value: { batch: { id: string }; available: null } }
    >("SELECT public.read_test_nucs_product($1,$2) value", [batchId, item.key]);
    assertEquals(job.rows[0].value.batch.id, batchId);
    assertEquals(job.rows[0].value.available, null);
    await assertRejects(() =>
      db.query("SELECT public.request_test_nucs_product($1,'missing')", [
        batchId,
      ])
    );
    const result = await captureNucsFlowEvidence(
      { dataset: "nucs_week_ahead_available", from: item.from, to: item.to },
      "synthetic-nucs-secret",
      async () => {},
      null,
      () => Promise.resolve(new Response(positionXml(true))),
    );
    const row = {
      id,
      batch_id: batchId,
      request_key: item.key,
      dataset: item.dataset,
      zone: item.zone,
      requested_from: item.from,
      requested_to: item.to,
      requested_at: "2026-11-27T12:00Z",
      resolved_at: "2026-11-27T12:01Z",
      result,
    };
    await db.query("SELECT record_test_market_observation($1,$2)", [
      row,
      assessMarketObservation(row),
    ]);
    const read = async () =>
      (await db.query<
        { c: { products: Record<string, { id: string; status: string }> } }
      >(
        "SELECT read_test_nucs_forecast_context($1,$2) c",
        [from, to],
      )).rows[0].c;
    const frozen = await read();
    assertEquals(frozen.products[item.dataset].id, id);
    const domainItem = plan[2], domainBytes = await bundle();
    await db.query("SELECT public.request_test_nucs_product($1,$2)", [
      batchId,
      domainItem.key,
    ]);
    assertEquals(
      (await db.query<{ url: string }>(
        "SELECT url FROM net.calls ORDER BY url",
      )).rows.map((r) => r.url),
      [
        "https://vxqpgbzseckgceopitpm.supabase.co/functions/v1/energy-market-archive",
        "https://vxqpgbzseckgceopitpm.supabase.co/functions/v1/energy-market-nucs-week",
      ],
    );
    const monthPlan = collectionPlan(
      "nucs_month_context",
      new Date("2026-11-27T12:00Z"),
    );
    const monthBatch = crypto.randomUUID();
    await db.query(
      "INSERT INTO energy_market_collection_batches(id,kind,requested_at,plan) VALUES($1,'nucs_month_context','2026-11-27T12:00Z',$2)",
      [monthBatch, monthPlan],
    );
    await db.query("SELECT public.request_test_nucs_product($1,$2)", [
      monthBatch,
      monthPlan[2].key,
    ]);
    assertEquals(
      (await db.query<{ url: string }>(
        "SELECT url FROM net.calls WHERE url LIKE '%nucs-month'",
      )).rows.length,
      1,
    );
    const linked = (await db.query<
      {
        value: {
          available: {
            id: string;
            evidence: {
              document: { publications: Record<string, unknown>[] };
            };
          };
        };
      }
    >(
      "SELECT public.read_test_nucs_product($1,$2) value",
      [batchId, domainItem.key],
    )).rows[0].value.available;
    assertEquals(linked.id, id);
    assertEquals(
      linked.evidence.document.publications[0].id,
      "synthetic-available",
    );
    assertEquals(
      "positions" in linked.evidence.document.publications[0],
      false,
    );
    const domainEvidence = await captureNucsFlowEvidence(
      {
        dataset: "nucs_week_ahead_domain",
        from: domainItem.from,
        to: domainItem.to,
      },
      "synthetic-nucs-secret",
      async () => {},
      { id, evidence: result },
      () => Promise.resolve(new Response(new Uint8Array(domainBytes))),
    );
    const domainRow = {
      ...row,
      id: crypto.randomUUID(),
      request_key: domainItem.key,
      dataset: domainItem.dataset,
      result: domainEvidence,
    };
    await assertRejects(() =>
      db.query("SELECT record_test_market_observation($1,$2)", [
        domainRow,
        assessMarketObservation(domainRow),
      ])
    );
    for (const archive of domainEvidence.native_archives ?? []) {
      await db.query(
        "INSERT INTO storage.objects(bucket_id,name) VALUES('test-energy-market-native',$1)",
        [archive.path],
      );
    }
    await db.query("SELECT record_test_market_observation($1,$2)", [
      domainRow,
      assessMarketObservation(domainRow),
    ]);
    assertEquals((await read()).products[domainItem.dataset].id, domainRow.id);
    const secondBatch = crypto.randomUUID();
    await db.query(
      "INSERT INTO energy_market_collection_batches(id,kind,requested_at,plan) VALUES($1,'nucs_week_context','2026-11-27T18:00Z',$2)",
      [secondBatch, plan],
    );
    const failed = {
      ...row,
      batch_id: secondBatch,
      id: crypto.randomUUID(),
      result: { ...result, status: "provider_error", error_code: "http_503" },
    };
    await db.query("SELECT record_test_market_observation($1,$2)", [
      failed,
      assessMarketObservation(failed),
    ]);
    assertEquals((await read()).products[item.dataset].id, failed.id);
    assertEquals(frozen.products[item.dataset].id, id);
    const thirdBatch = crypto.randomUUID();
    await db.query(
      "INSERT INTO energy_market_collection_batches(id,kind,requested_at,plan) VALUES($1,'nucs_week_context','2026-11-28T00:00Z',$2)",
      [thirdBatch, plan],
    );
    assertEquals((await read()).products[item.dataset].id, null);
    assertEquals(
      (await read()).products[item.dataset].status,
      "collection_incomplete",
    );
    const mismatched = {
      ...row,
      batch_id: thirdBatch,
      id: crypto.randomUUID(),
      result: {
        ...result,
        request: { ...result.request, dataset: "nucs_month_ahead_available" },
      },
    };
    await assertRejects(() =>
      db.query("SELECT record_test_market_observation($1,$2)", [
        mismatched,
        assessMarketObservation(mismatched),
      ])
    );
    await db.exec("SET ROLE authenticated");
    await assertRejects(read);
    await assertRejects(() =>
      db.query("SELECT public.read_test_nucs_product($1,$2)", [
        batchId,
        item.key,
      ])
    );
    await assertRejects(() =>
      db.query("SELECT public.request_test_nucs_product($1,$2)", [
        batchId,
        item.key,
      ])
    );
    await db.exec("RESET ROLE");
    assertEquals((await db.query("SELECT public FROM storage.buckets")).rows, [{
      public: false,
    }]);
  } finally {
    await db.close();
  }
});

Deno.test("native NUCS ZIP extraction enforces local identity and declared expanded bounds", async () => {
  for (const compression of ["STORE", "DEFLATE"] as const) {
    const zip = new JSZip();
    zip.file("synthetic.xml", "<synthetic>native</synthetic>");
    const bytes = await zip.generateAsync({ type: "uint8array", compression });
    const entry = marketZipDirectory(bytes)[0];
    assertEquals(
      new TextDecoder().decode(await marketZipMemberBytes(bytes, entry)),
      "<synthetic>native</synthetic>",
    );
    await assertRejects(() =>
      marketZipMemberBytes(bytes, { ...entry, bytes: entry.bytes - 1 })
    );
    await assertRejects(() =>
      marketZipMemberBytes(bytes, { ...entry, localOffset: bytes.length })
    );
    await assertRejects(() =>
      marketZipMemberBytes(bytes, { ...entry, name: "other.xml" })
    );
  }
});
