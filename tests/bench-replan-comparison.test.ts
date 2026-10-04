import { assertEquals } from "@std/assert";
import { realisticWorld } from "../src/lib/planner-bench/world.fixture.ts";
import { HOUSEHOLD } from "../src/lib/planner-bench/household.ts";
import { snapshotFor } from "../bench/adapter.ts";
import type { OptimisationSnapshot } from "../supabase/functions/_shared/planner/energy-optimisation.ts";
import { resolve, solve } from "../bench/experiments/replan-comparison.ts";
import type { StoreKey } from "../bench/experiments/replan-seed.ts";
const snapshot = () =>
  snapshotFor(
    realisticWorld(),
    HOUSEHOLD,
    1,
    true,
    false,
    false,
    true,
  ) as unknown as OptimisationSnapshot;
Deno.test("current backward pass replaces stale values instead of accepting old curves", () => {
  const p = resolve(snapshot());
  const altered = (key: StoreKey) => ({
    ...p.seed.stores[key],
    rows: p.seed.stores[key].rows.map((row) =>
      row.map((_, node) => 1e6 + node * 1e3)
    ),
  });
  const old = {
    ...p.seed,
    selectedRound: 1,
    prices: p.seed.quarters.map((q) => q.basePrice),
    stores: {
      battery: altered("battery"),
      ev: altered("ev"),
      pool: altered("pool"),
    },
  };
  const source = JSON.stringify(old);
  const cold = solve(p, null, 1), warm = solve(p, old, 1);
  assertEquals(warm.score, cold.score);
  assertEquals(warm.profile, cold.profile);
  assertEquals(warm.selected.stores, cold.selected.stores);
  assertEquals(JSON.stringify(old), source);
});
Deno.test("a new home comfort target yields the same new solve despite old estimates", () => {
  const input = snapshot(), old = solve(resolve(input), null, 2);
  input.comfort!.pool!.target_c += .5;
  const next = resolve(input),
    cold = solve(next, null, 2),
    warm = solve(next, old.selected, 2);
  assertEquals(warm.reuse.priceReason, "economics_changed");
  assertEquals(warm.reuse.priceRowsReused, 0);
  assertEquals(warm.reuse.stores.pool.reusedRows, 0);
  assertEquals(warm.score, cold.score);
  assertEquals(warm.profile, cold.profile);
});
