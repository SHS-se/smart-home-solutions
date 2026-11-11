import { assertEquals } from "jsr:@std/assert@1";
import { evReplacementPrice } from "./ev-price-history.ts";

const day = (date: string, prices: readonly number[]) => prices.map((price, index) => ({
  start_ts: new Date(Date.parse(date) + index * 900_000).toISOString(),
  import_price_sek_per_kwh: price,
}));

Deno.test("EV replacement prices learn from earlier contiguous charging windows", () => {
  const known = day("2026-01-01", [...Array(16).fill(2), ...Array(16).fill(0.9)]);
  const gap = day("2026-01-02", Array(16).fill(0.1)).filter((_slot, index) => index !== 8);
  const current = day("2026-01-03", Array(16).fill(-1));
  assertEquals(evReplacementPrice([...current, ...gap], "2026-01-03T18:00:00Z", "UTC"), null);
  const learned = evReplacementPrice([...current, ...known.reverse(), ...gap], "2026-01-03T18:00:00Z", "UTC");
  assertEquals(Math.round(learned! * 100), 90);
  assertEquals(evReplacementPrice([...known, ...current], "2026-01-04T00:00:00Z", "UTC"), 0);
});
