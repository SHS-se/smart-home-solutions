import { assert, assertEquals, assertThrows } from "@std/assert";
import { shardTests } from "../scripts/e2e-shard.mjs";

const test = (title: string, file = "replan-request.spec.ts") => ({ project: "chromium", file, titles: ["requesting a replan", title] });
const slow = [
  "ROI May–August sensor gaps generate, and month graphs use the same ledgers as ROI",
  "ROI reloads durable monthly totals without fetching history or generating charts",
  "the estimate holds one pool temperature in both columns, and changing it recalculates",
];

Deno.test("browser shards run every test exactly once", () => {
  const tests = [...slow, ...Array.from({ length: 40 }, (_, i) => `light ${i}`)].map(title => test(title));
  const shards = shardTests(tests, 3);
  const lines = shards.flat();
  assertEquals(lines.length, tests.length);
  assertEquals(new Set(lines).size, tests.length);
  assert(shards.every(shard => shard.length > 0));
  assertEquals(lines.find(line => line.endsWith("light 0")), "[chromium] › replan-request.spec.ts › requesting a replan › light 0");
});

Deno.test("adjacent slow browser tests land in different shards", () => {
  const shards = shardTests(slow.map(title => test(title)), 3);
  for (const title of slow) assertEquals(shards.filter(shard => shard.some(line => line.endsWith(title))).length, 1);
  assert(shards.every(shard => shard.length === 1));
});

Deno.test("a title the test-list format cannot express is rejected", () => {
  assertThrows(() => shardTests([test("a › b")], 2), Error, "›");
});
