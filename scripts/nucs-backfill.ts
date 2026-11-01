/** Retrieve NUCS history and retain its actual acquisition time. */
import {
  marketEvidenceClient,
  newPrivateEvidenceDirectory,
} from "./market-evidence-client.ts";
import {
  type MarketBatch,
  regionalCollectionPlan,
} from "../supabase/functions/_shared/market-collection-plan.ts";
import { nucsEvidenceFromResponse } from "../supabase/functions/_shared/nucs-market-data.ts";
import { assessMarketObservation } from "../supabase/functions/_shared/market-evidence-assessment.ts";
import {
  intervalCoverage,
  intervalMean,
} from "../supabase/functions/_shared/market-intervals.ts";
import { marketDaySpan } from "../supabase/functions/_shared/demand-forecast-quality.ts";
import type { MarketArchiveObservation } from "../supabase/functions/energy-market-archive/index.ts";
const args = Deno.args;
if (
  args.length !== 6 || args[0] !== "--from" || args[2] !== "--to" ||
  args[4] !== "--out" ||
  !/^\d{4}-\d{2}-\d{2}$/.test(args[1]) || !/^\d{4}-\d{2}-\d{2}$/.test(args[3])
) {
  throw new Error(
    "Usage: research:market:backfill-nucs --from FIRST_STOCKHOLM_DATE --to EXCLUSIVE_END_DATE --out NEW_PRIVATE_DIRECTORY",
  );
}
for (const day of [args[1], args[3]]) {
  if (new Date(day).toISOString().slice(0, 10) !== day) {
    throw new Error("Invalid calendar date");
  }
}
const from = marketDaySpan(args[1])[0], to = marketDaySpan(args[3])[0];
if (to > Date.now()) {
  throw new Error("History end must not be in the future");
}
const plan = regionalCollectionPlan(
  new Date(from).toISOString(),
  new Date(to).toISOString(),
);
const out = await newPrivateEvidenceDirectory(
  args.slice(4),
  "Expected --out NEW_PRIVATE_DIRECTORY",
);
const client = await marketEvidenceClient();
const batch: MarketBatch = {
  id: crypto.randomUUID(),
  kind: "regional_context",
  requested_at: new Date().toISOString(),
  plan,
};
await client.saveBatch(batch);
await Deno.writeTextFile(
  `${out}/manifest.json`,
  JSON.stringify(batch, null, 2) + "\n",
);
const rows: MarketArchiveObservation[] = [];
for (const item of plan) {
  if (
    item.dataset !== "nucs_week_ahead_ntc" &&
    item.dataset !== "nucs_transmission_outages"
  ) throw new Error("Unexpected history product");
  const query = {
    dataset: item.dataset,
    neighbour: item.neighbour!,
    direction: item.direction!,
    from: item.from,
    to: item.to,
  };
  const requestedAt = new Date().toISOString();
  const result = await nucsEvidenceFromResponse(
    query,
    await client.research(query),
  );
  const row: MarketArchiveObservation = {
    id: crypto.randomUUID(),
    batch_id: batch.id,
    request_key: item.key,
    dataset: item.dataset,
    zone: "SE3",
    requested_from: item.from,
    requested_to: item.to,
    requested_at: requestedAt,
    resolved_at: new Date().toISOString(),
    result,
  };
  await client.record(row, assessMarketObservation(row));
  rows.push(row);
  await Deno.writeTextFile(`${out}/${row.id}.json`, JSON.stringify(row) + "\n");
  console.log(
    `${item.dataset}/${item.neighbour}/${item.direction}: ${result.status}`,
  );
}
const dates: string[] = [];
for (
  let day = Date.parse(args[1]);
  day < Date.parse(args[3]);
  day += 86_400_000
) dates.push(new Date(day).toISOString().slice(0, 10));
const data = {
  from: args[1],
  to: args[3],
  capacities: rows.flatMap((row) => {
    if (row.dataset !== "nucs_week_ahead_ntc") return [];
    const intervals = row.result.status === "data"
      ? row.result.document.capacity_intervals
      : [];
    return dates.map((day) => {
      const [start, end] = marketDaySpan(day);
      return {
        day,
        neighbour: row.result.request.neighbour,
        direction: row.result.request.direction,
        capacity_mw: intervalMean(intervals, start, end),
        observation_id: row.id,
        downloaded_at: row.requested_at,
      };
    });
  }),
  outages: rows.flatMap((row) => {
    if (
      row.dataset !== "nucs_transmission_outages" ||
      row.result.status !== "data"
    ) return [];
    return row.result.document.notices.map((notice) => ({
      neighbour: row.result.request.neighbour,
      direction: row.result.request.direction,
      observation_id: row.id,
      downloaded_at: row.requested_at,
      ...notice,
    }));
  }),
};
const sources = rows.map((row) => {
  if (
    row.dataset !== "nucs_week_ahead_ntc" &&
    row.dataset !== "nucs_transmission_outages"
  ) throw new Error("Unexpected source");
  const document = row.result.status === "data" ? row.result.document : null;
  return {
    id: row.id,
    dataset: row.dataset,
    neighbour: row.result.request.neighbour,
    direction: row.result.request.direction,
    status: row.result.status,
    http_status: row.result.http_status,
    ...(row.dataset === "nucs_week_ahead_ntc"
      ? {
        coverage: intervalCoverage(
          document?.capacity_intervals ?? [],
          from,
          to,
        ),
        dates: data.capacities.filter((c) => c.observation_id === row.id).map(
          (c) => ({ day: c.day, complete: c.capacity_mw !== null }),
        ),
      }
      : {
        notice_documents: document?.notices.length ?? null,
        cancelled_documents: document?.notices.filter((n) =>
          n.status === "A09"
        ).length ?? null,
      }),
  };
});
await Deno.writeTextFile(
  `${out}/data.json`,
  JSON.stringify(data, null, 2) + "\n",
);
const report = {
  batch_id: batch.id,
  retrieved_at: batch.requested_at,
  dates,
  requested: plan.length,
  saved: rows.length,
  sources,
  interpretation:
    "NUCS records for the requested dates. Provider revisions and actual retrieval timestamps are retained.",
};
await Deno.writeTextFile(
  `${out}/report.json`,
  JSON.stringify(report, null, 2) + "\n",
);
console.log(
  JSON.stringify(
    { batch_id: batch.id, saved: rows.length, out },
    null,
    2,
  ),
);
if (sources.some((s) => !["data", "no_data"].includes(s.status))) {
  throw new Error(
    "Backfill contains failed requests; inspect the retained report",
  );
}
