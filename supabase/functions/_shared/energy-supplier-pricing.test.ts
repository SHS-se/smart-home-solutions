import {
  assertEquals,
  assertThrows,
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
});
