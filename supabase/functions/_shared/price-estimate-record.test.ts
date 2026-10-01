import { assertEquals } from "jsr:@std/assert@1";
import { priceEstimateRows } from "./price-estimate-record.ts";

Deno.test("only days the market has not published are kept, by local day and quarter", () => {
  // Issued 2026-10-02 14:00 local: today and tomorrow are published, the two days after are estimated.
  const start = Date.parse("2026-10-02T12:00:00Z");
  const publishedUntil = Date.parse("2026-10-03T22:00:00Z");
  const slots = Array.from({ length: 288 }, (_, i) => {
    const at = start + i * 900_000;
    return { start: new Date(at).toISOString(), import_price_sek_per_kwh: at < publishedUntil ? 1 : null };
  });
  const rows = priceEstimateRows({
    homeId: "home", timezone: "Europe/Stockholm", issuedAt: new Date(start).toISOString(), slots,
    shadowImportSekPerKwh: slots.map((_, i) => 1 + i / 1000), basis: "wind",
  });
  assertEquals(rows.map((row) => [row.issued_on, row.target_day, row.basis, row.quarters.filter((v) => v !== null).length]), [
    ["2026-10-02", "2026-10-04", "wind", 96],
    // The plan ends at 14:00 local on the fifth: 56 quarters of that day.
    ["2026-10-02", "2026-10-05", "wind", 56],
  ]);
  // 2026-10-04 00:00 local is 22:00 UTC on the third: slot 136.
  assertEquals(rows[0].quarters[0], 1.136);
});

Deno.test("a plan with no estimate, or one that does not match its slots, keeps nothing", () => {
  const slots = [{ start: "2026-10-02T12:00:00Z", import_price_sek_per_kwh: null }];
  assertEquals(priceEstimateRows({ homeId: "h", timezone: "UTC", issuedAt: "2026-10-02T12:00:00Z", slots, shadowImportSekPerKwh: undefined, basis: undefined }), []);
  assertEquals(priceEstimateRows({ homeId: "h", timezone: "UTC", issuedAt: "2026-10-02T12:00:00Z", slots, shadowImportSekPerKwh: [1, 2], basis: undefined }), []);
});
