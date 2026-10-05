import { assertEquals, assertThrows } from "@std/assert";
import { shardFiles, testArguments, testFiles } from "../scripts/run-unit-tests.ts";

const root = new URL("..", import.meta.url).pathname;

Deno.test("CI shards run every repository test file exactly once, including new files", () => {
  const files = [...testFiles(root), "src/lib/a-new-test.test.ts"];
  const shards = shardFiles(files, 4);
  assertEquals(shards.flat().sort(), files.sort());
  assertEquals(new Set(shards.flat()).size, files.length);
  assertEquals(shardFiles([...files].reverse(), 4), shards);
  // The two slowest modules must not serialize behind one another.
  assertEquals(shards.filter(shard => shard.includes("supabase/functions/_shared/planner/energy-optimisation-allocation.test.ts") ||
    shard.includes("supabase/functions/_shared/replan-continuity.test.ts")).length, 2);
});

Deno.test("local and CI unit tests use the same runner options and discovery roots", () => {
  const local = testArguments([], root);
  for (let index = 1; index <= 4; index++) {
    const shard = testArguments(["--shard", `${index}/4`], root);
    assertEquals(shard.slice(0, 8), local.slice(0, 8));
    assertEquals(shard.slice(8), shardFiles(testFiles(root), 4)[index - 1]);
  }
  assertEquals(local.slice(8), ["tests/", "src/lib/", "supabase/functions/"]);
});

Deno.test("invalid unit test shard arguments fail instead of silently omitting tests", () => {
  for (const args of [["--shard", "0/4"], ["--shard", "5/4"], ["--shard", "1/0"], ["--shard"], ["--filter", "planner"]]) {
    assertThrows(() => testArguments(args, root));
  }
});
