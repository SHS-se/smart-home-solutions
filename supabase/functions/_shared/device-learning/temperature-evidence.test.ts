import { assertAlmostEquals, assertEquals } from "@std/assert";
import { isolatedTemperatureCorrections } from "./temperature-evidence.ts";

const quarter = 900_000;
const series = (values: (number | null)[]) => values.map((c, i) => ({ at: i * quarter, c }));

Deno.test("an isolated reversal is estimated from its neighbors without changing raw observations", () => {
  const readings = series([20, 20.1, 20.2, 40, 20.4, 20.5, 20.6]);
  const corrections = isolatedTemperatureCorrections(readings, quarter);
  assertEquals([...corrections.keys()], [3 * quarter]);
  assertAlmostEquals(corrections.get(3 * quarter)!, 20.3);
  assertEquals(readings[3].c, 40);
});

Deno.test("sustained steps, missing observations and non-isolated reversals are preserved", () => {
  for (const readings of [
    series([20, 20, 20, 25, 25, 25, 25]),
    series([20, 20, 20, 40, null, 20, 20, 20]),
    series([20, 20, 20, 40, 20, 40, 20, 20, 20, 20, 20, 20]),
    series([20, 20, 20, 40, 20, 20, 20]).filter(row => row.at !== 4 * quarter),
  ]) assertEquals(isolatedTemperatureCorrections(readings, quarter).size, 0);
});
