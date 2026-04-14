import { assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";

import {
  getQuarterForMonth,
  getQuarterMonths,
  hasVatFilingConfirmation,
  isAccountingPeriodLockedByVatFiling,
} from "@/lib/vat-periods.ts";

Deno.test("getQuarterMonths returns the three months in a quarter", () => {
  assertEquals(getQuarterMonths(1), [1, 2, 3]);
  assertEquals(getQuarterMonths(2), [4, 5, 6]);
  assertEquals(getQuarterMonths(4), [10, 11, 12]);
});

Deno.test("getQuarterForMonth maps a month to its quarter", () => {
  assertEquals(getQuarterForMonth(1), 1);
  assertEquals(getQuarterForMonth(6), 2);
  assertEquals(getQuarterForMonth(11), 4);
});

Deno.test("hasVatFilingConfirmation requires both stored file path and timestamp", () => {
  assertEquals(hasVatFilingConfirmation({
    year: 2026,
    quarter: 1,
    filing_confirmation_path: "2026/q1/receipt.pdf",
    filing_confirmed_at: "2026-04-14T12:00:00Z",
  }), true);
  assertEquals(hasVatFilingConfirmation({
    year: 2026,
    quarter: 1,
    filing_confirmation_path: "2026/q1/receipt.pdf",
    filing_confirmed_at: null,
  }), false);
});

Deno.test("isAccountingPeriodLockedByVatFiling freezes months inside a filed quarter", () => {
  const vatPeriods = [
    {
      year: 2026,
      quarter: 1,
      filing_confirmation_path: "2026/q1/receipt.pdf",
      filing_confirmed_at: "2026-04-14T12:00:00Z",
    },
  ];

  assertEquals(isAccountingPeriodLockedByVatFiling({ year: 2026, month: 2 }, vatPeriods), true);
  assertEquals(isAccountingPeriodLockedByVatFiling({ year: 2026, month: 4 }, vatPeriods), false);
});
