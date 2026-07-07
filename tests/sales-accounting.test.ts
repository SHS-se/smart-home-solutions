import { assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";

import {
  buildCustomerPaymentJournalLines,
  buildSalesInvoiceJournalLines,
  computeSalesInvoiceTotals,
  resolveSalesPostingPeriod,
  salesVatBoxesFromJournalLines,
  type AccountingPeriodRow,
} from "@/lib/sales-accounting.ts";
import { finalizeVatDeclarationAmounts } from "@/lib/vat-declaration.ts";
import { getQuarterForMonth } from "@/lib/vat-periods.ts";

// IN-000001 line items as captured from production.
const IN_000001_LINES = [
  { description: "Unifi Device Bridge", quantity: 1, unit_price: 1220, tax_rate: 25 },
  { description: "Unifi Dream Router 7", quantity: 1, unit_price: 3425, tax_rate: 25 },
  { description: "Nabu Casa Home Assistant Green", quantity: 1, unit_price: 1915, tax_rate: 25 },
  { description: "Frakt och logistik", quantity: 2, unit_price: 95, tax_rate: 25 },
];

Deno.test("computeSalesInvoiceTotals matches invoice_computed_totals for IN-000001", () => {
  const totals = computeSalesInvoiceTotals(IN_000001_LINES);
  assertEquals(totals.net, 6750);
  assertEquals(totals.vat, 1687.5);
  assertEquals(totals.gross, 8437.5);
  assertEquals(totals.vatByRate[25], 1687.5);
});

Deno.test("domestic 25% sale posts 1510 gross, 3010 net, 2611 VAT and balances", () => {
  const lines = buildSalesInvoiceJournalLines(IN_000001_LINES, "Försäljningsfaktura IN-000001");
  assertEquals(lines.map((l) => l.account), ["1510", "3010", "2611"]);
  assertEquals(lines[0].debit, 8437.5);
  assertEquals(lines[1].credit, 6750);
  assertEquals(lines[2].credit, 1687.5);
  const debit = lines.reduce((s, l) => s + l.debit, 0);
  const credit = lines.reduce((s, l) => s + l.credit, 0);
  assertEquals(debit, credit);
});

Deno.test("mixed VAT rates post to 2611/2621/2631 by rate", () => {
  const lines = buildSalesInvoiceJournalLines([
    { description: "Hårdvara", quantity: 1, unit_price: 1000, tax_rate: 25 },
    { description: "Livsmedel", quantity: 1, unit_price: 500, tax_rate: 12 },
    { description: "Bok", quantity: 1, unit_price: 200, tax_rate: 6 },
  ], "Test");
  assertEquals(lines.map((l) => l.account), ["1510", "3010", "2611", "2621", "2631"]);
  assertEquals(lines[2].credit, 250);
  assertEquals(lines[3].credit, 60);
  assertEquals(lines[4].credit, 12);
});

Deno.test("domestic 25% sale maps to box05 and box10 from journal lines", () => {
  const journal = buildSalesInvoiceJournalLines(IN_000001_LINES, "IN-000001");
  const boxes = salesVatBoxesFromJournalLines(journal);
  assertEquals(boxes.box05, 6750);
  assertEquals(boxes.box10, 1687.5);
  assertEquals(boxes.box11, 0);
  assertEquals(boxes.box12, 0);
});

Deno.test("box49 equals output VAT minus input VAT", () => {
  const amounts = finalizeVatDeclarationAmounts({
    box05: 6750,
    box10: 1687.5,
    box11: 0,
    box12: 0,
    box20: 4981,
    box21: 0,
    box22: 1731,
    box30: 1678,
    box31: 0,
    box32: 0,
    box48: 3667,
  });
  // Output VAT (10+11+12+30+31+32) − input VAT (48). Box 10 (1687.5) is
  // truncated to 1687 per Skatteverket's öre-dropping rule.
  assertEquals(amounts.momsBetala, (1687 + 1678) - 3667);
});

const PERIODS_Q1_LOCKED: AccountingPeriodRow[] = [
  { id: "jan", year: 2026, month: 1, status: "locked" },
  { id: "feb", year: 2026, month: 2, status: "locked" },
  { id: "mar", year: 2026, month: 3, status: "locked" },
  { id: "apr", year: 2026, month: 4, status: "open" },
  { id: "may", year: 2026, month: 5, status: "open" },
];

Deno.test("invoice in open period posts on its own date, not as correction", () => {
  const resolution = resolveSalesPostingPeriod("2026-04-15", PERIODS_Q1_LOCKED);
  assertEquals(resolution?.period.id, "apr");
  assertEquals(resolution?.verificationDate, "2026-04-15");
  assertEquals(resolution?.isCorrection, false);
});

Deno.test("invoice in locked Q1 period is corrected into April (first open period)", () => {
  // IN-000001 finalized 2026-03-26, Jan–Mar locked after Q1 filing.
  const resolution = resolveSalesPostingPeriod("2026-03-26", PERIODS_Q1_LOCKED);
  assertEquals(resolution?.period.id, "apr");
  assertEquals(resolution?.verificationDate, "2026-04-01");
  assertEquals(resolution?.isCorrection, true);
  // The locked Q1 periods are untouched — no period status changes here;
  // the correction lands in Q2 by verification date.
  assertEquals(getQuarterForMonth(4), 2);
});

Deno.test("no open period yields null instead of touching locked periods", () => {
  const resolution = resolveSalesPostingPeriod("2026-03-26", [
    { id: "jan", year: 2026, month: 1, status: "locked" },
  ]);
  assertEquals(resolution, null);
});

Deno.test("Q2 boxes include a correction posted in April for an omitted Q1 invoice", () => {
  const correctionJournal = buildSalesInvoiceJournalLines(IN_000001_LINES, "Korrigering IN-000001")
    .map((l) => ({ ...l, verification_date: "2026-04-01" }));
  const q2Lines = correctionJournal.filter((l) => {
    const month = Number(l.verification_date.slice(5, 7));
    return getQuarterForMonth(month) === 2;
  });
  const boxes = salesVatBoxesFromJournalLines(q2Lines);
  assertEquals(boxes.box05, 6750);
  assertEquals(boxes.box10, 1687.5);

  // The filed Q1 snapshot is immutable: Q1 sales boxes stay at their filed
  // values (all zero) regardless of corrections posted in Q2.
  const filedQ1SalesBoxes = { box05: 0, box10: 0, box11: 0, box12: 0 };
  const q1Lines = correctionJournal.filter((l) => {
    const month = Number(l.verification_date.slice(5, 7));
    return getQuarterForMonth(month) === 1;
  });
  assertEquals(salesVatBoxesFromJournalLines(q1Lines), filedQ1SalesBoxes);
});

Deno.test("bankgiro and manual payments settle via 1930, stripe via 1580", () => {
  for (const method of ["bankgiro", "manual"] as const) {
    const lines = buildCustomerPaymentJournalLines(8437.5, method, "Kundbetalning IN-000001");
    assertEquals(lines.map((l) => l.account), ["1930", "1510"]);
    assertEquals(lines[0].debit, 8437.5);
    assertEquals(lines[1].credit, 8437.5);
  }
  // Legacy Stripe settlement for IN-000001 (payment date 2026-04-01):
  // debit Stripe clearing, credit receivables — no fee or payout inferred.
  const stripe = buildCustomerPaymentJournalLines(8437.5, "stripe", "Kundbetalning IN-000001");
  assertEquals(stripe.map((l) => l.account), ["1580", "1510"]);
  assertEquals(stripe[0].debit, 8437.5);
  assertEquals(stripe[1].credit, 8437.5);
});
