/** Synthetic archived records; no measured or household history. */
import { assertEquals, assertThrows } from "@std/assert";
import { marketFoundationDb } from "./helpers/market-foundation-db.ts";
import {
  isCurrentCollection,
  type MarketBatch,
  regionalCollectionPlan,
} from "../supabase/functions/_shared/market-collection-plan.ts";
import { assessMarketObservation } from "../supabase/functions/_shared/market-evidence-assessment.ts";
import { marketDaySpan } from "../supabase/functions/_shared/demand-forecast-quality.ts";
const id = (n: number) =>
  `${String(n).padStart(8, "0")}-3333-4333-8333-333333333333`;
Deno.test("regional history covers the 25-hour day and remains the same twenty closed products", () => {
  const from = new Date(marketDaySpan("2026-10-22")[0]).toISOString(),
    to = new Date(marketDaySpan("2026-11-01")[0]).toISOString();
  const plan = regionalCollectionPlan(from, to);
  assertEquals(plan.length, 20);
  assertEquals(new Set(plan.map((p) => p.key)).size, 20);
  assertEquals((Date.parse(to) - Date.parse(from)) / 3_600_000, 241);
  assertThrows(() => regionalCollectionPlan(from, "2026-11-20T00:00:00Z"));
});
Deno.test("downloaded history needs no label and does not replace current heads, context or health inputs", async () => {
  const db = await marketFoundationDb();
  try {
    for (
      const migration of [
        "20261101144000_market_data_foundation",
        "20261101162000_weather_accuracy_quality_monitor",
        "20261101164000_verified_regional_context",
        "20261101180000_retrospective_regional_backfill",
        "20261101181000_native_history_request_windows",
      ]
    ) {
      await db.exec(
        await Deno.readTextFile(`supabase/migrations/${migration}.sql`),
      );
    }
    await db.exec("SELECT private.enable_test_market_archive()");
    const now =
      (await db.query<{ now: string }>("SELECT clock_timestamp()::text now"))
        .rows[0].now;
    const livePlan = regionalCollectionPlan(
      new Date(Math.floor(Date.parse(now) / 60_000) * 60_000 - 86_400_000)
        .toISOString(),
      new Date(Math.floor(Date.parse(now) / 60_000) * 60_000 + 9 * 86_400_000)
        .toISOString(),
    );
    const oldPlan = regionalCollectionPlan(
      "2026-10-21T22:00:00Z",
      "2026-10-31T23:00:00Z",
    );
    const current: MarketBatch = {
      id: id(1),
      kind: "regional_context",
      requested_at: now,
      plan: livePlan,
    };
    const history: MarketBatch = { ...current, id: id(2), plan: oldPlan };
    assertEquals(isCurrentCollection(current), true);
    assertEquals(isCurrentCollection(history), false);
    for (const [i, batch] of [current, history].entries()) {
      await db.query(
        "INSERT INTO energy_market_collection_batches(id,kind,requested_at,plan) VALUES($1,$2,$3,$4)",
        [batch.id, batch.kind, batch.requested_at, batch.plan],
      );
      const p = batch.plan[0];
      const row = {
        id: id(10 + i),
        batch_id: batch.id,
        request_key: p.key,
        dataset: p.dataset,
        zone: p.zone,
        requested_from: p.from,
        requested_to: p.to,
        requested_at: now,
        resolved_at: now,
        result: {
          status: "no_data",
          http_status: 400,
          error_code: "no_matching_data",
          request: {
            dataset: p.dataset,
            neighbour: p.neighbour,
            direction: p.direction,
          },
        },
      };
      await db.query("SELECT record_test_market_observation($1,$2)", [
        row,
        assessMarketObservation(row),
      ]);
    }
    assertEquals(
      (await db.query("SELECT id FROM energy_market_operational_observations"))
        .rows,
      [{ id: id(10) }],
    );
    assertEquals(
      (await db.query(
        "SELECT column_name FROM information_schema.columns WHERE table_name='energy_market_collection_batches' AND column_name='purpose'",
      )).rows,
      [],
    );
    const context = (await db.query<
      { c: { research_batches: { regional_context: { batch_id: string } } } }
    >("SELECT read_test_price_forecast_context() c")).rows[0].c;
    assertEquals(
      context.research_batches.regional_context.batch_id,
      current.id,
    );
    await db.exec("SELECT private.evaluate_test_market_health()");
    const manifest = (await db.query<
      { m: { source_heads: { id: string }[]; batches: { id: string }[] } }
    >("SELECT manifest m FROM energy_market_quality_intents WHERE kind='collection_health'"))
      .rows[0].m;
    assertEquals(manifest.source_heads.map((s) => s.id), [id(10)]);
    assertEquals(manifest.batches.map((b) => b.id), [current.id]);
  } finally {
    await db.close();
  }
});
