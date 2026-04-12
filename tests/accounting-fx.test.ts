import { assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import {
  normalizeCurrency,
  isForeignCurrency,
  roundMoney,
  parseAmount,
  formatCurrencyAmount,
  convertDocumentAmounts,
  buildExchangeSnapshot,
  getPurchaseExchangeSnapshot,
  allocateConvertedLineAmounts,
  buildPurchaseVatSummary,
  detectForeignCurrencyIntegrityIssue,
  nearlyEqual,
  describeJournalOriginalAmount,
  derivePaymentAccountOriginalAmount,
} from "@/lib/accounting-fx.ts";
import type { PurchaseLike, PurchaseExchangeSnapshot, PurchaseLineAmounts } from "@/lib/accounting-fx.ts";

// ─── normalizeCurrency ──────────────────────────────────────────────────────────

Deno.test("normalizeCurrency uppercases and trims", () => {
  assertEquals(normalizeCurrency("usd"), "USD");
  assertEquals(normalizeCurrency(" eur "), "EUR");
  assertEquals(normalizeCurrency("SEK"), "SEK");
});

Deno.test("normalizeCurrency returns SEK for null/undefined/empty", () => {
  assertEquals(normalizeCurrency(null), "SEK");
  assertEquals(normalizeCurrency(undefined), "SEK");
  assertEquals(normalizeCurrency(""), "SEK");
});

// ─── isForeignCurrency ──────────────────────────────────────────────────────────

Deno.test("isForeignCurrency returns false for SEK", () => {
  assertEquals(isForeignCurrency("SEK"), false);
  assertEquals(isForeignCurrency("sek"), false);
  assertEquals(isForeignCurrency(null), false);
});

Deno.test("isForeignCurrency returns true for non-SEK", () => {
  assertEquals(isForeignCurrency("USD"), true);
  assertEquals(isForeignCurrency("EUR"), true);
});

// ─── roundMoney ─────────────────────────────────────────────────────────────────

Deno.test("roundMoney rounds to 2 decimal places", () => {
  assertEquals(roundMoney(1.005), 1.01);
  assertEquals(roundMoney(1.004), 1.0);
  assertEquals(roundMoney(100.999), 101.0);
  assertEquals(roundMoney(0), 0);
});

Deno.test("roundMoney handles floating-point precision", () => {
  // Classic JS issue: 0.1 + 0.2 = 0.30000000000000004
  assertEquals(roundMoney(0.1 + 0.2), 0.3);
});

Deno.test("roundMoney handles negative numbers", () => {
  assertEquals(roundMoney(-1.005), -1.0);
  assertEquals(roundMoney(-99.999), -100.0);
});

// ─── parseAmount ────────────────────────────────────────────────────────────────

Deno.test("parseAmount handles numbers", () => {
  assertEquals(parseAmount(100), 100);
  assertEquals(parseAmount(0), 0);
  assertEquals(parseAmount(-50), -50);
});

Deno.test("parseAmount handles strings", () => {
  assertEquals(parseAmount("100"), 100);
  assertEquals(parseAmount("12.50"), 12.5);
});

Deno.test("parseAmount returns 0 for invalid", () => {
  assertEquals(parseAmount(null), 0);
  assertEquals(parseAmount(undefined), 0);
  assertEquals(parseAmount("abc"), 0);
  assertEquals(parseAmount(NaN), 0);
  assertEquals(parseAmount(Infinity), 0);
});

// ─── convertDocumentAmounts ─────────────────────────────────────────────────────

Deno.test("convertDocumentAmounts applies rate and derives VAT", () => {
  const result = convertDocumentAmounts({ gross: 10, net: 8, vat: 2 }, 9.5);
  assertEquals(result.gross, 95);
  assertEquals(result.net, 76);
  assertEquals(result.vat, 19); // gross - net = 95 - 76
});

Deno.test("convertDocumentAmounts with rate 1 preserves amounts", () => {
  const result = convertDocumentAmounts({ gross: 125, net: 100, vat: 25 }, 1);
  assertEquals(result.gross, 125);
  assertEquals(result.net, 100);
  assertEquals(result.vat, 25);
});

// ─── buildExchangeSnapshot ──────────────────────────────────────────────────────

Deno.test("buildExchangeSnapshot for SEK purchase", () => {
  const result = buildExchangeSnapshot({
    documentDate: "2026-03-30",
    currency: "SEK",
    originalAmounts: { gross: 125, net: 100, vat: 25 },
    lookup: { currency: "SEK", rate: 1, rateDate: "2026-03-30", source: "SEK" },
  });
  assertEquals(result.exchangeRateSource, "SEK");
  assertEquals(result.exchangeRate, 1);
  assertEquals(result.convertedGrossSek, 125);
  assertEquals(result.originalCurrency, "SEK");
});

Deno.test("buildExchangeSnapshot for USD purchase with ECB rate", () => {
  const result = buildExchangeSnapshot({
    documentDate: "2026-03-30",
    currency: "USD",
    originalAmounts: { gross: 10, net: 10, vat: 0 },
    lookup: { currency: "USD", rate: 9.4967, rateDate: "2026-03-28", source: "ECB" },
  });
  assertEquals(result.exchangeRateSource, "ECB");
  assertEquals(result.exchangeRate, 9.4967);
  assertEquals(result.originalCurrency, "USD");
  assertEquals(result.convertedGrossSek, roundMoney(10 * 9.4967));
  assertEquals(result.ecbExchangeRate, 9.4967);
});

Deno.test("buildExchangeSnapshot with manual override", () => {
  const result = buildExchangeSnapshot({
    documentDate: "2026-03-30",
    currency: "EUR",
    originalAmounts: { gross: 25, net: 25, vat: 0 },
    lookup: { currency: "EUR", rate: 11.0, rateDate: "2026-03-28", source: "ECB" },
    overrideRate: 11.5,
    overrideReason: "Bank rate used",
  });
  assertEquals(result.exchangeRateSource, "MANUAL_OVERRIDE");
  assertEquals(result.exchangeRate, 11.5);
  assertEquals(result.exchangeRateOverridden, true);
  assertEquals(result.exchangeRateOverrideReason, "Bank rate used");
  assertEquals(result.convertedGrossSek, roundMoney(25 * 11.5));
  assertEquals(result.ecbExchangeRate, 11.0); // ECB rate still stored
});

// ─── getPurchaseExchangeSnapshot ────────────────────────────────────────────────

Deno.test("getPurchaseExchangeSnapshot from null returns SEK defaults", () => {
  const result = getPurchaseExchangeSnapshot(null);
  assertEquals(result.originalCurrency, "SEK");
  assertEquals(result.exchangeRateSource, "SEK");
  assertEquals(result.convertedGrossSek, 0);
});

Deno.test("getPurchaseExchangeSnapshot reads purchase fields", () => {
  const purchase: PurchaseLike = {
    original_currency: "USD",
    original_gross_amount: 10,
    original_net_amount: 10,
    original_vat_amount: 0,
    converted_gross_amount_sek: 95,
    converted_net_amount_sek: 95,
    converted_vat_amount_sek: 0,
    exchange_rate_source: "ECB",
    exchange_rate_date: "2026-03-28",
    exchange_rate: 9.5,
    document_date: "2026-03-30",
  };
  const result = getPurchaseExchangeSnapshot(purchase);
  assertEquals(result.originalCurrency, "USD");
  assertEquals(result.originalGross, 10);
  assertEquals(result.convertedGrossSek, 95);
  assertEquals(result.exchangeRateSource, "ECB");
  assertEquals(result.exchangeRate, 9.5);
});

Deno.test("getPurchaseExchangeSnapshot uses LEGACY_UNCONVERTED for foreign without source", () => {
  const purchase: PurchaseLike = {
    original_currency: "USD",
    gross_amount: 10,
  };
  const result = getPurchaseExchangeSnapshot(purchase);
  assertEquals(result.exchangeRateSource, "LEGACY_UNCONVERTED");
});

// ─── nearlyEqual ────────────────────────────────────────────────────────────────

Deno.test("nearlyEqual within tolerance", () => {
  assertEquals(nearlyEqual(100.00, 100.00), true);
  assertEquals(nearlyEqual(100.001, 100.004), true); // both round to 100.00
  assertEquals(nearlyEqual(99.995, 100.00), true);   // 99.995 rounds to 100.00
});

Deno.test("nearlyEqual outside tolerance", () => {
  assertEquals(nearlyEqual(100, 101), false);
  assertEquals(nearlyEqual(100, 100.02), false);
});

// ─── allocateConvertedLineAmounts ───────────────────────────────────────────────

Deno.test("allocateConvertedLineAmounts — single line gets full amount", () => {
  const snapshot = getPurchaseExchangeSnapshot({
    original_currency: "USD",
    converted_gross_amount_sek: 95,
    converted_net_amount_sek: 95,
    converted_vat_amount_sek: 0,
  });
  const lines: PurchaseLineAmounts[] = [{
    expense_account: "6540",
    vat_treatment: "reverse_charge",
    gross_amount: 10,
    net_amount: 10,
    vat_amount: 0,
  }];
  const result = allocateConvertedLineAmounts(lines, snapshot);
  assertEquals(result[0].gross_amount, 95);
  assertEquals(result[0].net_amount, 95);
});

Deno.test("allocateConvertedLineAmounts — two equal lines split evenly", () => {
  const snapshot = getPurchaseExchangeSnapshot({
    original_currency: "USD",
    converted_gross_amount_sek: 100,
    converted_net_amount_sek: 80,
    converted_vat_amount_sek: 20,
  });
  const lines: PurchaseLineAmounts[] = [
    { expense_account: "6540", vat_treatment: "domestic_deductible", gross_amount: 5, net_amount: 4, vat_amount: 1 },
    { expense_account: "6540", vat_treatment: "domestic_deductible", gross_amount: 5, net_amount: 4, vat_amount: 1 },
  ];
  const result = allocateConvertedLineAmounts(lines, snapshot);
  assertEquals(result[0].gross_amount + result[1].gross_amount, 100);
  assertEquals(result[0].net_amount + result[1].net_amount, 80);
  assertEquals(result[0].vat_amount + result[1].vat_amount, 20);
});

Deno.test("allocateConvertedLineAmounts — rounding remainder goes to last line", () => {
  const snapshot = getPurchaseExchangeSnapshot({
    original_currency: "USD",
    converted_gross_amount_sek: 100,
    converted_net_amount_sek: 100,
    converted_vat_amount_sek: 0,
  });
  const lines: PurchaseLineAmounts[] = [
    { expense_account: "6540", vat_treatment: "reverse_charge", gross_amount: 1, net_amount: 1, vat_amount: 0 },
    { expense_account: "6540", vat_treatment: "reverse_charge", gross_amount: 1, net_amount: 1, vat_amount: 0 },
    { expense_account: "6540", vat_treatment: "reverse_charge", gross_amount: 1, net_amount: 1, vat_amount: 0 },
  ];
  const result = allocateConvertedLineAmounts(lines, snapshot);
  const totalGross = result.reduce((s, l) => s + l.gross_amount, 0);
  assertEquals(roundMoney(totalGross), 100);
});

Deno.test("allocateConvertedLineAmounts — empty lines returns empty", () => {
  const snapshot = getPurchaseExchangeSnapshot(null);
  const result = allocateConvertedLineAmounts([], snapshot);
  assertEquals(result.length, 0);
});

// ─── buildPurchaseVatSummary ────────────────────────────────────────────────────

Deno.test("buildPurchaseVatSummary — domestic deductible", () => {
  const snapshot = getPurchaseExchangeSnapshot({
    original_currency: "SEK",
    gross_amount: 125,
    net_amount: 100,
    vat_amount: 25,
  });
  const lines: PurchaseLineAmounts[] = [{
    expense_account: "6540",
    vat_treatment: "domestic_deductible",
    gross_amount: 125,
    net_amount: 100,
    vat_amount: 25,
  }];
  const result = buildPurchaseVatSummary(lines, snapshot);
  assertEquals(result.deductibleInputVatSek, 25);
  assertEquals(result.paymentAccountAmountSek, 125);
  assertEquals(result.reverseChargeBaseSek, 0);
  assertEquals(result.reverseChargeOutputVatSek, 0);
});

Deno.test("buildPurchaseVatSummary — reverse charge", () => {
  const snapshot = getPurchaseExchangeSnapshot({
    original_currency: "USD",
    converted_gross_amount_sek: 95,
    converted_net_amount_sek: 95,
    converted_vat_amount_sek: 0,
  });
  const lines: PurchaseLineAmounts[] = [{
    expense_account: "6540",
    vat_treatment: "reverse_charge",
    gross_amount: 95,
    net_amount: 95,
    vat_amount: 0,
  }];
  const result = buildPurchaseVatSummary(lines, snapshot);
  assertEquals(result.reverseChargeBaseSek, 95);
  assertEquals(result.reverseChargeOutputVatSek, 23.75); // 95 * 0.25
  assertEquals(result.reverseChargeInputVatSek, 23.75); // same — neutral
  assertEquals(result.paymentAccountAmountSek, 95); // net for RC
  assertEquals(result.deductibleInputVatSek, 0);
});

Deno.test("buildPurchaseVatSummary — non-deductible includes VAT in gross", () => {
  const snapshot = getPurchaseExchangeSnapshot({
    original_currency: "SEK",
    gross_amount: 125,
    net_amount: 100,
    vat_amount: 25,
  });
  const lines: PurchaseLineAmounts[] = [{
    expense_account: "6540",
    vat_treatment: "non_deductible",
    gross_amount: 125,
    net_amount: 100,
    vat_amount: 25,
  }];
  const result = buildPurchaseVatSummary(lines, snapshot);
  assertEquals(result.nonDeductibleVatIncludedSek, 25);
  assertEquals(result.deductibleInputVatSek, 0);
  assertEquals(result.paymentAccountAmountSek, 125); // gross for non-deductible
});

Deno.test("buildPurchaseVatSummary — no_vat uses net for payment", () => {
  const snapshot = getPurchaseExchangeSnapshot({ original_currency: "SEK", gross_amount: 200, net_amount: 200, vat_amount: 0 });
  const lines: PurchaseLineAmounts[] = [{
    expense_account: "6540",
    vat_treatment: "no_vat",
    gross_amount: 200,
    net_amount: 200,
    vat_amount: 0,
  }];
  const result = buildPurchaseVatSummary(lines, snapshot);
  assertEquals(result.paymentAccountAmountSek, 200);
  assertEquals(result.deductibleInputVatSek, 0);
});

// ─── detectForeignCurrencyIntegrityIssue ────────────────────────────────────────

Deno.test("detectForeignCurrencyIntegrityIssue — SEK purchase returns null", () => {
  const purchase: PurchaseLike = { original_currency: "SEK", gross_amount: 100 };
  const expected = getPurchaseExchangeSnapshot(purchase);
  assertEquals(detectForeignCurrencyIntegrityIssue(purchase, expected), null);
});

Deno.test("detectForeignCurrencyIntegrityIssue — properly converted USD returns null", () => {
  const purchase: PurchaseLike = {
    original_currency: "USD",
    original_gross_amount: 10,
    original_net_amount: 10,
    original_vat_amount: 0,
    converted_gross_amount_sek: 95,
    converted_net_amount_sek: 95,
    converted_vat_amount_sek: 0,
    exchange_rate_source: "ECB",
    exchange_rate_date: "2026-03-28",
    exchange_rate: 9.5,
  };
  const expected = getPurchaseExchangeSnapshot(purchase);
  assertEquals(detectForeignCurrencyIntegrityIssue(purchase, expected), null);
});

Deno.test("detectForeignCurrencyIntegrityIssue — LEGACY_UNCONVERTED flags issue", () => {
  const purchase: PurchaseLike = {
    original_currency: "USD",
    gross_amount: 10, // still in USD, not converted
    exchange_rate_source: "LEGACY_UNCONVERTED",
  };
  const expected = getPurchaseExchangeSnapshot({
    ...purchase,
    converted_gross_amount_sek: 95,
    converted_net_amount_sek: 95,
    converted_vat_amount_sek: 0,
    exchange_rate_source: "ECB",
    exchange_rate: 9.5,
    exchange_rate_date: "2026-03-28",
  });
  const issue = detectForeignCurrencyIntegrityIssue(purchase, expected);
  assertEquals(issue !== null, true);
  assertEquals(issue!.reason.includes("Missing"), true);
});

Deno.test("detectForeignCurrencyIntegrityIssue — mismatched stored vs expected SEK amounts", () => {
  const purchase: PurchaseLike = {
    original_currency: "USD",
    original_gross_amount: 10,
    original_net_amount: 10,
    original_vat_amount: 0,
    converted_gross_amount_sek: 90, // wrong
    converted_net_amount_sek: 90,
    converted_vat_amount_sek: 0,
    exchange_rate_source: "ECB",
    exchange_rate_date: "2026-03-28",
    exchange_rate: 9.5,
  };
  const expected = getPurchaseExchangeSnapshot({
    ...purchase,
    converted_gross_amount_sek: 95,
    converted_net_amount_sek: 95,
  });
  const issue = detectForeignCurrencyIntegrityIssue(purchase, expected);
  assertEquals(issue !== null, true);
  assertEquals(issue!.reason.includes("differ"), true);
});

Deno.test("detectForeignCurrencyIntegrityIssue — draft vs posted status", () => {
  const purchase: PurchaseLike = {
    original_currency: "USD",
    gross_amount: 10,
    exchange_rate_source: "LEGACY_UNCONVERTED",
    status: "draft",
  };
  const expected = getPurchaseExchangeSnapshot({
    ...purchase,
    converted_gross_amount_sek: 95,
    exchange_rate_source: "ECB",
    exchange_rate: 9.5,
    exchange_rate_date: "2026-03-28",
  });
  const issueDraft = detectForeignCurrencyIntegrityIssue(purchase, expected);
  assertEquals(issueDraft!.status, "draft_requires_backfill");

  const postedPurchase = { ...purchase, status: "posted" };
  const issuePosted = detectForeignCurrencyIntegrityIssue(postedPurchase, expected);
  assertEquals(issuePosted!.status, "posted_requires_backfill");
});

// ─── derivePaymentAccountOriginalAmount ─────────────────────────────────────────

Deno.test("derivePaymentAccountOriginalAmount — reverse charge uses net", () => {
  const snapshot = getPurchaseExchangeSnapshot({
    original_currency: "USD",
    original_gross_amount: 10,
    original_net_amount: 10,
    original_vat_amount: 0,
  });
  assertEquals(derivePaymentAccountOriginalAmount("reverse_charge", snapshot), 10);
});

Deno.test("derivePaymentAccountOriginalAmount — domestic deductible uses gross", () => {
  const snapshot = getPurchaseExchangeSnapshot({
    original_currency: "SEK",
    original_gross_amount: 125,
    original_net_amount: 100,
    original_vat_amount: 25,
  });
  assertEquals(derivePaymentAccountOriginalAmount("domestic_deductible", snapshot), 125);
});

// ─── describeJournalOriginalAmount ──────────────────────────────────────────────

Deno.test("describeJournalOriginalAmount — expense returns net for deductible", () => {
  const snapshot = getPurchaseExchangeSnapshot({
    original_currency: "USD",
    original_gross_amount: 10,
    original_net_amount: 8,
    original_vat_amount: 2,
    exchange_rate_source: "ECB",
  });
  assertEquals(describeJournalOriginalAmount("expense", "domestic_deductible", snapshot), 8);
});

Deno.test("describeJournalOriginalAmount — expense returns gross for non_deductible", () => {
  const snapshot = getPurchaseExchangeSnapshot({
    original_currency: "USD",
    original_gross_amount: 10,
    original_net_amount: 8,
    original_vat_amount: 2,
    exchange_rate_source: "ECB",
  });
  assertEquals(describeJournalOriginalAmount("expense", "non_deductible", snapshot), 10);
});

Deno.test("describeJournalOriginalAmount — reverse_charge_vat returns null", () => {
  const snapshot = getPurchaseExchangeSnapshot({
    original_currency: "USD",
    original_gross_amount: 10,
    original_net_amount: 10,
    original_vat_amount: 0,
    exchange_rate_source: "ECB",
  });
  assertEquals(describeJournalOriginalAmount("reverse_charge_vat", "reverse_charge", snapshot), null);
});

Deno.test("describeJournalOriginalAmount — input_vat returns original VAT", () => {
  const snapshot = getPurchaseExchangeSnapshot({
    original_currency: "SEK",
    original_gross_amount: 125,
    original_net_amount: 100,
    original_vat_amount: 25,
  });
  assertEquals(describeJournalOriginalAmount("input_vat", "domestic_deductible", snapshot), 25);
});
