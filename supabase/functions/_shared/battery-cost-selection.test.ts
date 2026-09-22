import { assertEquals, assertRejects } from "@std/assert";
import { snapshot } from "../../../src/lib/energy-shift/optimisation-snapshot.fixture.ts";
import {
  type CostCurveInput,
  costCurveKey,
  type CostCurveRecord,
} from "./battery-cost-curve.ts";
import {
  type CostCurveDatabase,
  resolveCostCurve,
} from "./battery-cost-selection.ts";
import { EnergyPlanningError } from "./energy-planning-client.ts";
import { ENERGY_PLANNING_PROTOCOL } from "./energy-planning-protocol.ts";
import { handleBatteryCostCurve } from "./battery-cost-portal.ts";

type Row = Record<string, unknown>;
function database() {
  const rows = new Map<string, Row>();
  let loseNextUpdate: (() => void) | undefined;
  const db = {
    from() {
      const query = (update?: Row) => {
        const filters: [string, unknown][] = [];
        let newest = false;
        const execute = () => {
          if (update && loseNextUpdate) {
            const lose = loseNextUpdate;
            loseNextUpdate = undefined;
            lose();
            return { data: null, error: null };
          }
          const row =
            (newest ? [...rows.values()].reverse() : [...rows.values()]).find((
              row,
            ) => filters.every(([key, value]) => (row[key] ?? null) === value));
          if (row && update) Object.assign(row, structuredClone(update));
          return { data: row ? structuredClone(row) : null, error: null };
        };
        const builder = {
          order() {
            newest = true;
            return builder;
          },
          limit() {
            return builder;
          },
          eq(key: string, value: unknown) {
            filters.push([key, value]);
            return builder;
          },
          is(key: string, value: unknown) {
            filters.push([key, value]);
            return builder;
          },
          select() {
            return builder;
          },
          single: () => Promise.resolve(execute()),
          maybeSingle: () => Promise.resolve(execute()),
          then<TResult1 = ReturnType<typeof execute>, TResult2 = never>(
            onfulfilled?:
              | ((
                value: ReturnType<typeof execute>,
              ) => TResult1 | PromiseLike<TResult1>)
              | null,
            onrejected?:
              | ((reason: unknown) => TResult2 | PromiseLike<TResult2>)
              | null,
          ) {
            return Promise.resolve(execute()).then(onfulfilled, onrejected);
          },
        };
        return builder;
      };
      return {
        upsert(row: Row) {
          const key = `${row.home_id}:${row.key}`;
          if (!rows.has(key)) {
            rows.set(key, structuredClone({ ...row, record: null }));
          }
          return Promise.resolve({ data: null, error: null });
        },
        select: () => query(),
        update: (row: Row) => query(row),
      };
    },
  } satisfies CostCurveDatabase;
  return {
    db,
    rows,
    loseUpdate: (fn: () => void) => {
      loseNextUpdate = fn;
    },
  };
}
const input = (): CostCurveInput => {
  const source = snapshot();
  return { snapshot: source, now: source.captured_at };
};
const connection = {
  url: "https://worker.test",
  planningSecret: "secret",
  requestId: "request",
};
async function record(source: CostCurveInput): Promise<CostCurveRecord> {
  return {
    key: await costCurveKey(source),
    curve: {
      unit: "kwh",
      points: [{ at: 0, sek_per_unit: 1 }, { at: 10, sek_per_unit: 0 }],
    },
    source_snapshot_id: source.snapshot.snapshot_id,
    evaluations: 2,
    bill_before_sek: 10,
    bill_after_sek: 9,
    published_until: source.snapshot.slots.at(-1)!.start,
  };
}
const response = (body: object) =>
  Response.json({
    protocol: ENERGY_PLANNING_PROTOCOL,
    request_id: "request",
    ...body,
  });
const worker = (
  fn: (body: Record<string, unknown>) => Response | Promise<Response>,
): typeof fetch =>
(_url, options) => Promise.resolve(fn(JSON.parse(String(options?.body))));

Deno.test("cost selection persists compact progress and reuses frozen source across reloads", async () => {
  const { db, rows } = database();
  const source = input();
  const selected = await record(source);
  let calls = 0;
  const fetcher = worker((body) => {
    assertEquals(body.kind, "cost_curve");
    assertEquals(body.input, source);
    calls++;
    if (calls === 1) {
      return response({
        done: false,
        progress: { evaluations: [{ curve: selected.curve, bill_sek: 10 }] },
      });
    }
    assertEquals(body.progress, {
      evaluations: [{ curve: selected.curve, bill_sek: 10 }],
    });
    return response({ done: true, record: selected });
  });
  const first = await resolveCostCurve(
    db,
    "home",
    "customer",
    source,
    connection,
    fetcher,
  );
  const changed = structuredClone(source);
  changed.snapshot.snapshot_id = "different-snapshot";
  changed.snapshot.battery!.soc = 0.8;
  const second = await resolveCostCurve(
    db,
    "home",
    "customer",
    changed,
    connection,
    fetcher,
  );
  assertEquals(second, first);
  assertEquals(calls, 2);
  assertEquals([...rows.values()][0].progress, { evaluations: [] });
});

Deno.test("cost selection CAS loser returns the winner's immutable result", async () => {
  const { db, rows, loseUpdate } = database();
  const source = input();
  const selected = await record(source);
  const winner = { ...selected, bill_after_sek: 8 };
  loseUpdate(() =>
    Object.assign([...rows.values()][0], { record: winner, revision: 1 })
  );
  const result = await resolveCostCurve(
    db,
    "home",
    "customer",
    source,
    connection,
    worker(() => response({ done: true, record: selected })),
  );
  assertEquals(result.selection, winner);
});

Deno.test("cost selection propagates 546 without retry and resumes persisted progress next request", async () => {
  const { db } = database();
  const source = input();
  const selected = await record(source);
  const progress = {
    evaluations: [{ curve: selected.curve, bill_sek: 10 }],
    current: { completed: [] },
  };
  let calls = 0;
  await assertRejects(
    () =>
      resolveCostCurve(
        db,
        "home",
        "customer",
        source,
        connection,
        worker(() => {
          if (++calls === 1) return response({ done: false, progress });
          return Response.json({ error: "WORKER_RESOURCE_LIMIT" }, {
            status: 546,
          });
        }),
      ),
    EnergyPlanningError,
    "HTTP 546 (WORKER_RESOURCE_LIMIT)",
  );
  assertEquals(calls, 2);
  const newer = structuredClone(source);
  newer.snapshot.snapshot_id = "new-measurement";
  await resolveCostCurve(
    db,
    "home",
    "customer",
    newer,
    connection,
    worker((body) => {
      assertEquals(body.input, source);
      assertEquals(body.progress, progress);
      return response({ done: true, record: selected });
    }),
  );
});

Deno.test("cost selection rejects mismatched worker record before persisting", async () => {
  const { db, rows } = database();
  const source = input();
  const selected = await record(source);
  await assertRejects(
    () =>
      resolveCostCurve(
        db,
        "home",
        "customer",
        source,
        connection,
        worker(() =>
          response({ done: true, record: { ...selected, key: "wrong" } })
        ),
      ),
    EnergyPlanningError,
    "invalid battery curve record",
  );
  assertEquals([...rows.values()][0].record, null);
});

Deno.test("portal authorizes home before resolving and ignores user supplied snapshot", async () => {
  const source = input();
  const selected = await record(source);
  let resolutions = 0;
  const deps = {
    readHome: (authorization: string, homeId: string) => {
      assertEquals(authorization, "Bearer caller");
      return Promise.resolve(
        homeId === "allowed" ? { customerId: "customer", input: source } : null,
      );
    },
    resolve: (_homeId: string, home: { input: CostCurveInput }) => {
      resolutions++;
      assertEquals(home.input, source);
      return Promise.resolve({ selection: selected, input: source });
    },
  };
  const request = (homeId: string) =>
    new Request("https://portal.test", {
      method: "POST",
      headers: { Authorization: "Bearer caller" },
      body: JSON.stringify({ home_id: homeId, snapshot: { injected: true } }),
    });
  assertEquals(
    (await handleBatteryCostCurve(request("forbidden"), deps)).status,
    404,
  );
  assertEquals(resolutions, 0);
  const allowed = await handleBatteryCostCurve(request("allowed"), deps);
  assertEquals(allowed.status, 200);
  assertEquals(await allowed.json(), { selection: selected, input: source });
  assertEquals(
    (await handleBatteryCostCurve(
      new Request("https://portal.test", { method: "POST" }),
      deps,
    )).status,
    401,
  );
});

Deno.test("cost selection survives elapsed quarters and rolling slots until published prices change", async () => {
  const { db, rows } = database();
  const source = input();
  let calls = 0;
  const fetcher = worker(async (body) => {
    calls++;
    return response({
      done: true,
      record: await record(body.input as CostCurveInput),
    });
  });
  const first = await resolveCostCurve(
    db,
    "home",
    "customer",
    source,
    connection,
    fetcher,
  );
  const later = structuredClone(source);
  later.now = new Date(Date.parse(source.now) + 3 * 900_000).toISOString();
  later.snapshot.slots = later.snapshot.slots.slice(3);
  later.snapshot.snapshot_id = "later-quarter";
  later.snapshot.battery!.soc = .3;
  later.snapshot.value_curves = {
    battery: { unit: "kwh", points: [{ at: 0, sek_per_unit: 9 }] },
  };
  assertEquals(
    await resolveCostCurve(db, "home", "customer", later, connection, fetcher),
    first,
  );
  assertEquals(calls, 1);
  assertEquals(rows.size, 1);
  later.snapshot.slots[0].import_price_sek_per_kwh! += .01;
  await resolveCostCurve(db, "home", "customer", later, connection, fetcher);
  assertEquals(calls, 2);
  const newlyPublished = later.snapshot.slots.find((slot) =>
    slot.import_price_sek_per_kwh === null
  )!;
  newlyPublished.import_price_sek_per_kwh = 1.25;
  newlyPublished.export_price_sek_per_kwh = .1;
  await resolveCostCurve(db, "home", "customer", later, connection, fetcher);
  assertEquals(calls, 3);
});
