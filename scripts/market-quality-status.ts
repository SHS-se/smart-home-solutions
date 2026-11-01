/** Compact read-only status for the notification heartbeat. No provider calls or writes. */
import { marketEvidenceClient } from "./market-evidence-client.ts";
interface Cell {
  variable: string;
  quality: string;
  lead_day: number;
  matched: number;
  expected: number;
  absolute: number;
  squared: number;
  signed: number;
  target_dates: number;
}
interface Status {
  at: string;
  cursor: number;
  events: unknown[];
  open_problems: unknown[];
  latest: Record<
    string,
    {
      id: string;
      slot: string;
      completed_at: string;
      summary: { cells?: Cell[]; [key: string]: unknown };
    }
  >;
}
const args = Deno.args;
if (
  args.length &&
  (args.length !== 2 || args[0] !== "--since" || !/^\d+$/.test(args[1]))
) {
  throw new Error(
    "Usage: deno task research:market:status [--since EVENT_SEQUENCE]",
  );
}
const client = await marketEvidenceClient();
const status = await client.status(args.length ? Number(args[1]) : 0) as Status;
for (const run of Object.values(status.latest)) {
  if (!run.summary.cells) continue;
  const groups = new Map<string, Cell[]>();
  for (const cell of run.summary.cells) {
    const key = `${cell.variable}/${cell.quality}/D+${cell.lead_day}`;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key)!.push(cell);
  }
  run.summary.by_variable_and_lead = [...groups].map(([key, rows]) => {
    const n = rows.reduce((s, r) => s + r.matched, 0);
    return {
      key,
      matched_hours: n,
      expected_hours: rows.reduce((s, r) => s + r.expected, 0),
      mae: n ? rows.reduce((s, r) => s + r.absolute, 0) / n : null,
      rmse: n ? Math.sqrt(rows.reduce((s, r) => s + r.squared, 0) / n) : null,
      bias: n ? rows.reduce((s, r) => s + r.signed, 0) / n : null,
      site_target_date_counts: {
        minimum: Math.min(...rows.map((r) => r.target_dates)),
        maximum: Math.max(...rows.map((r) => r.target_dates)),
      },
    };
  });
  delete run.summary.cells;
}
console.log(JSON.stringify(status, null, 2));
