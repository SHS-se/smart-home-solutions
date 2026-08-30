import { assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import { classifyOutdoorSeries } from "./outdoor-forecast.ts";

Deno.test("a complete series is handed back as numbers", () => {
  assertEquals(classifyOutdoorSeries([4, 5, 6], 3), {
    status: "complete",
    series: [4, 5, 6],
  });
});

Deno.test("no provider reached the horizon, so the plan goes on without one", () => {
  assertEquals(classifyOutdoorSeries(undefined, 3), { status: "absent" });
  assertEquals(classifyOutdoorSeries(null, 3), { status: "absent" });
});

Deno.test("a hole is not an absence: it is a series that was built and not filled", () => {
  assertEquals(classifyOutdoorSeries([4, null, 6], 3), { status: "holed" });
});

Deno.test("a short series is rejected rather than planned against its own length", () => {
  assertEquals(classifyOutdoorSeries([4, 5], 3), { status: "holed" });
});

Deno.test("a non-finite reading is a hole, whatever produced it", () => {
  assertEquals(classifyOutdoorSeries([4, Number.NaN, 6], 3), {
    status: "holed",
  });
  assertEquals(classifyOutdoorSeries([4, Number.POSITIVE_INFINITY, 6], 3), {
    status: "holed",
  });
});

Deno.test("an empty horizon carries an empty series, not a hole", () => {
  assertEquals(classifyOutdoorSeries([], 0), { status: "complete", series: [] });
});
