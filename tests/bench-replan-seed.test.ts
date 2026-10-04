import { assertEquals, assertNotStrictEquals, assertThrows } from "@std/assert";
import {
  prepareReplanStart,
  type ReplanProblem,
  type SelectedEstimates,
  type ValueSeed,
} from "../bench/experiments/replan-seed.ts";
const store = (economics = "comfort-v1"): ValueSeed => ({
  layout: "states-2",
  model: "physics-v1",
  economics,
  rows: [[1, 2], [3, 4]],
});
const problem = (): ReplanProblem => ({
  home: "test-home",
  algorithm: "prototype-v1",
  resources: "grid-v1",
  quarters: [{
    start: "2026-10-04T10:00:00Z",
    hours: .25,
    basePrice: 1,
    importPrice: 1,
    exportPrice: .5,
  }, {
    start: "2026-10-04T10:15:00Z",
    hours: .25,
    basePrice: 2,
    importPrice: 2,
    exportPrice: 1,
  }],
  stores: { battery: store(), ev: store(), pool: store() },
});
const previous = (): SelectedEstimates => ({
  ...problem(),
  selectedRound: 3,
  prices: [3, 5],
});
Deno.test("fresh solve starts from current prices and independently owned rows", () => {
  const p = problem(), seed = prepareReplanStart(p, null);
  assertEquals(seed.prices, [1, 2]);
  assertEquals(seed.alignedQuarters, 0);
  seed.values.pool[0][0] = 99;
  assertEquals(p.stores.pool.rows[0][0], 1);
});
Deno.test("shift aligns absolute quarters, rebases premiums, and initializes new tail", () => {
  const old = previous(), p = problem();
  const shifted = {
    ...p,
    quarters: [{
      start: old.quarters[1].start,
      hours: .25,
      basePrice: 10,
      importPrice: 10,
      exportPrice: 5,
    }, {
      start: "2026-10-04T10:30:00Z",
      hours: .25,
      basePrice: 20,
      importPrice: 20,
      exportPrice: 10,
    }],
  };
  const seed = prepareReplanStart(shifted, old);
  assertEquals(seed.prices, [13, 20]);
  assertEquals(seed.alignedQuarters, 1);
  for (const key of ["battery", "ev", "pool"] as const) {
    assertEquals(seed.values[key], [[3, 4], [3, 4]]);
    assertEquals(seed.stores[key], { reusedRows: 1, reason: "aligned" });
    assertNotStrictEquals(seed.values[key][0], old.stores[key].rows[1]);
  }
});
Deno.test("a comfort change refreshes that device rather than importing old utility", () => {
  const p = problem(),
    seed = prepareReplanStart({
      ...p,
      stores: {
        ...p.stores,
        pool: { ...store("comfort-v2"), rows: [[40, 50], [60, 70]] },
      },
    }, previous());
  assertEquals(seed.values.pool, [[40, 50], [60, 70]]);
  assertEquals(seed.stores.pool.reason, "economics_changed");
  assertEquals(seed.prices, [1, 2]);
  assertEquals(seed.priceReason, "economics_changed");
  assertEquals(seed.priceRowsReused, 0);
  assertEquals(seed.stores.ev.reusedRows, 2);
  assertEquals(seed.stores.battery.reusedRows, 2);
});
Deno.test("changed physical model and changed state layout have explicit fresh seeds", () => {
  const p = problem(),
    seed = prepareReplanStart({
      ...p,
      stores: {
        ...p.stores,
        battery: { ...store(), model: "new-battery" },
        ev: { ...store(), layout: "states-3", rows: [[1, 2, 3], [4, 5, 6]] },
      },
    }, previous());
  assertEquals(seed.stores.battery.reason, "model_changed");
  assertEquals(seed.stores.ev.reason, "layout_changed");
  assertEquals(seed.stores.battery.reusedRows, 0);
  assertEquals(seed.stores.ev.reusedRows, 0);
  assertEquals(seed.stores.pool.reusedRows, 2);
});
Deno.test("a partially elapsed quarter starts from its current-duration seed", () => {
  const p = problem();
  const seed = prepareReplanStart({
    ...p,
    quarters: [{ ...p.quarters[0], hours: .1 }, p.quarters[1]],
  }, previous());
  assertEquals(seed.prices, [1, 5]);
  assertEquals(seed.alignedQuarters, 1);
});
Deno.test("reused prices never overwrite current tariff changes", () => {
  const p = problem();
  assertEquals(
    prepareReplanStart({
      ...p,
      quarters: p.quarters.map((q) => ({
        ...q,
        basePrice: q.basePrice - 10,
        importPrice: q.importPrice - 10,
        exportPrice: q.exportPrice - 10,
      })),
    }, previous()).prices,
    [-7, -5],
  );
});
Deno.test("cross-home and unsupported algorithm seeds fail explicitly", () => {
  assertThrows(
    () =>
      prepareReplanStart({ ...problem(), home: "different-home" }, previous()),
    Error,
    "different home",
  );
  assertThrows(
    () =>
      prepareReplanStart(
        { ...problem(), algorithm: "new-algorithm" },
        previous(),
      ),
    Error,
    "Unsupported",
  );
});
Deno.test("malformed stored numeric estimates are errors, not silent fresh starts", () => {
  assertThrows(
    () => prepareReplanStart(problem(), { ...previous(), prices: [2] }),
    Error,
    "shape mismatch",
  );
  assertThrows(
    () => prepareReplanStart(problem(), { ...previous(), prices: [NaN, 2] }),
    Error,
    "Non-finite",
  );
  const old = previous();
  assertThrows(
    () =>
      prepareReplanStart(problem(), {
        ...old,
        stores: { ...old.stores, ev: { ...store(), rows: [[NaN, 1], [2, 3]] } },
      }),
    Error,
    "invalid value row",
  );
});
Deno.test("preparing a seed does not alter the selected solve or current problem", () => {
  const p = problem(), old = previous(), original = JSON.stringify({ p, old });
  const seed = prepareReplanStart(p, old);
  seed.prices[0] = -99;
  seed.values.ev[0][0] = -99;
  assertEquals(JSON.stringify({ p, old }), original);
});

Deno.test("changed household limits initialize shared prices from current inputs", () => {
  const seed = prepareReplanStart(
    { ...problem(), resources: "grid-v2" },
    previous(),
  );
  assertEquals(seed.priceReason, "resources_changed");
  assertEquals(seed.priceRowsReused, 0);
  assertEquals(seed.prices, [1, 2]);
  assertEquals(seed.stores.ev.reusedRows, 2);
});

Deno.test("changing from forecast surplus to deficit does not invent a scarcity markup", () => {
  const p = problem(),
    old = {
      ...previous(),
      quarters: p.quarters.map((q) => ({ ...q, basePrice: q.exportPrice })),
      prices: [.75, 1.5],
    };
  const seed = prepareReplanStart(p, old);
  assertEquals(seed.prices, [.75, 1.5]); // same market prices, same valid estimate
});
Deno.test("tariff spread changes preserve market position separately from resource scarcity", () => {
  const p = problem(), old = { ...previous(), prices: [.75, 1.5] };
  const next = {
    ...p,
    quarters: p.quarters.map((q) => ({
      ...q,
      basePrice: 10,
      importPrice: 10,
      exportPrice: 2,
    })),
  };
  assertEquals(prepareReplanStart(next, old).prices, [6, 6]);
});
