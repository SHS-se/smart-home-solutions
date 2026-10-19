import {
  assertEquals,
  assertThrows,
  assertAlmostEquals,
} from "https://deno.land/std@0.190.0/testing/asserts.ts";
import {
  calculateSupplierPrice,
  parseSpotPriceIntervals,
} from "./energy-supplier-pricing.ts";

const tibber = {
  schema_version: 1,
  vat_rate: 0.25,
  import: {
    spot_multiplier: 1,
    fixed_markup_sek_per_kwh_ex_vat: 0.06,
    variable_cost_sek_per_kwh_ex_vat: 0.041,
  },
  export: { spot_multiplier: 1, adjustment_sek_per_kwh: 0 },
  monthly_fee_sek_in_vat: 49,
};

Deno.test("Tibber import adds its costs and VAT while export stays at spot", () => {
  assertEquals(
    calculateSupplierPrice({
      SEK_per_kWh: 0.8,
      time_start: "2026-08-13T12:00:00+02:00",
      time_end: "2026-08-13T12:15:00+02:00",
    }, tibber),
    {
      start: "2026-08-13T12:00:00+02:00",
      end: "2026-08-13T12:15:00+02:00",
      spot_price_sek_per_kwh: 0.8,
      supplier_import_price_sek_per_kwh: 1.12625,
      supplier_export_price_sek_per_kwh: 0.8,
    },
  );
});

Deno.test("spot intervals must be contiguous native quarters", () => {
  assertThrows(() =>
    parseSpotPriceIntervals([{
      SEK_per_kWh: 0.8,
      time_start: "2026-08-13T12:00:00+02:00",
      time_end: "2026-08-13T13:00:00+02:00",
    }])
  );
  assertThrows(() =>
    parseSpotPriceIntervals([
      { SEK_per_kWh: 0.8, time_start: "2026-08-13T12:00:00Z", time_end: "2026-08-13T12:15:00Z" },
      { SEK_per_kWh: 0.9, time_start: "2026-08-13T12:30:00Z", time_end: "2026-08-13T12:45:00Z" },
    ])
  );
});

Deno.test('hourly quotes from before the 2025-10-01 quarter market hold their price for all four quarters', async () => {
  const raw = JSON.parse(await Deno.readTextFile(new URL('./elprisetjustnu-2025-09-15-se3.fixture.json', import.meta.url)));
  assertEquals(raw.length, 24);
  const rows = parseSpotPriceIntervals(raw);
  assertEquals(rows.length, 96);
  assertEquals(rows[0].time_start, '2025-09-15T00:00:00+02:00');
  assertEquals(rows.slice(28, 32).map(row => [row.time_start, row.time_end, row.SEK_per_kWh]), [
    ['2025-09-15T07:00:00+02:00', '2025-09-15T07:15:00+02:00', .55118],
    ['2025-09-15T07:15:00+02:00', '2025-09-15T07:30:00+02:00', .55118],
    ['2025-09-15T07:30:00+02:00', '2025-09-15T07:45:00+02:00', .55118],
    ['2025-09-15T07:45:00+02:00', '2025-09-15T08:00:00+02:00', .55118],
  ]);
  assertEquals(rows[95].time_end, '2025-09-16T00:00:00+02:00');
  rows.forEach(row => assertEquals(Date.parse(row.time_end) - Date.parse(row.time_start), 900_000));
  assertThrows(() =>
    parseSpotPriceIntervals([{
      SEK_per_kWh: 0.8,
      time_start: '2025-10-01T00:00:00+02:00',
      time_end: '2025-10-01T01:00:00+02:00',
    }])
  );
});

Deno.test('October DST price quotes retain all 100 quarters despite the feed’s wrong repeated-hour end label', async () => {
  const raw = JSON.parse(await Deno.readTextFile(new URL('./elprisetjustnu-2025-10-26-se3.fixture.json', import.meta.url)));
  const rows = parseSpotPriceIntervals(raw);
  assertEquals(rows.length, 100);
  assertEquals(rows[11].time_end, '2025-10-26T02:00:00+01:00');
  assertAlmostEquals(rows[11].SEK_per_kWh, .02627);
  assertEquals(rows[12].time_start, '2025-10-26T02:00:00+01:00');
  rows.forEach(row => assertEquals(Date.parse(row.time_end) - Date.parse(row.time_start), 900_000));
});
