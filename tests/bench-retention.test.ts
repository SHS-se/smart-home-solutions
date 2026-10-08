import { assertEquals, assertThrows } from "@std/assert";
import { BENCH_BASELINE_COMMITTED_AT, retainedCommit } from "../bench/retention.ts";

Deno.test("benchmark retention includes main baseline and newer commits, excluding older explicit selections", () => {
  assertEquals(retainedCommit(BENCH_BASELINE_COMMITTED_AT), true);
  assertEquals(retainedCommit("2026-10-08T10:12:04+02:00"), true);
  assertEquals(retainedCommit("2026-10-07T18:12:58+02:00"), false);
  assertThrows(() => retainedCommit("bad timestamp"), Error, "Invalid benchmark commit timestamp");
});
