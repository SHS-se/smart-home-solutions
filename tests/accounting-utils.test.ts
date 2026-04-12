import { assertEquals, assertArrayIncludes } from "https://deno.land/std@0.224.0/assert/mod.ts";
import {
  formatSEK,
  formatSEKDecimal,
  formatExchangeRate,
  getCreditAccount,
  getAccountName,
  suggestExpenseAccount,
  buildJournalPreview,
  getPurchaseBlockers,
} from "@/lib/accounting-utils.ts";
import type { PaymentSource, VatTreatment } from "@/lib/accounting-utils.ts";

// ─── formatSEK ─────────────────────────────────────────────────────────────────

Deno.test("formatSEK formats positive integer", () => {
  assertEquals(formatSEK(1000), "1\u00a0000 kr");
});

Deno.test("formatSEK formats zero", () => {
  assertEquals(formatSEK(0), "0 kr");
});

Deno.test("formatSEK rounds to nearest integer", () => {
  // formatSEK uses maximumFractionDigits: 0
  const result = formatSEK(99.7);
  assertEquals(result, "100 kr");
});

Deno.test("formatSEK formats negative number", () => {
  const result = formatSEK(-500);
  assertEquals(result, "\u2212500 kr");
});

// ─── formatSEKDecimal ───────────────────────────────────────────────────────────

Deno.test("formatSEKDecimal shows two decimals", () => {
  const result = formatSEKDecimal(123.4);
  assertEquals(result, "123,40 kr");
});

Deno.test("formatSEKDecimal formats zero", () => {
  assertEquals(formatSEKDecimal(0), "0,00 kr");
});

// ─── formatExchangeRate ─────────────────────────────────────────────────────────

Deno.test("formatExchangeRate returns dash for null", () => {
  assertEquals(formatExchangeRate(null), "—");
});

Deno.test("formatExchangeRate returns dash for undefined", () => {
  assertEquals(formatExchangeRate(undefined), "—");
});

Deno.test("formatExchangeRate returns dash for NaN", () => {
  assertEquals(formatExchangeRate(NaN), "—");
});

Deno.test("formatExchangeRate formats valid rate", () => {
  const result = formatExchangeRate(9.4967);
  // Should have 4-6 decimal places
  assertEquals(result.includes("9,4967"), true);
});

// ─── getCreditAccount ───────────────────────────────────────────────────────────

Deno.test("getCreditAccount returns 2018 for owner_paid", () => {
  const result = getCreditAccount("owner_paid");
  assertEquals(result.account, "2018");
  assertEquals(result.name, "Egna insättningar");
});

Deno.test("getCreditAccount returns 1930 for company_bank", () => {
  const result = getCreditAccount("company_bank");
  assertEquals(result.account, "1930");
  assertEquals(result.name, "Företagskonto");
});

// ─── getAccountName ─────────────────────────────────────────────────────────────

Deno.test("getAccountName returns known account", () => {
  assertEquals(getAccountName("2641"), "Ingående moms");
  assertEquals(getAccountName("6540"), "IT-tjänster");
});

Deno.test("getAccountName returns empty for unknown", () => {
  assertEquals(getAccountName("9999"), "");
});

// ─── suggestExpenseAccount ──────────────────────────────────────────────────────

Deno.test("suggestExpenseAccount matches fingerprint first", () => {
  assertEquals(suggestExpenseAccount("openai_invoice", "Some Company"), "6540");
  assertEquals(suggestExpenseAccount("bbqkees_invoice", "BBQKees Electronics B.V."), "5410");
});

Deno.test("suggestExpenseAccount falls back to supplier name", () => {
  assertEquals(suggestExpenseAccount(null, "Amazon EU"), "5410");
  assertEquals(suggestExpenseAccount(null, "OpenAI Inc"), "6540");
  assertEquals(suggestExpenseAccount(null, "Stripe Payments"), "6590");
});

Deno.test("suggestExpenseAccount defaults to 4000", () => {
  assertEquals(suggestExpenseAccount(null, "Unknown Corp"), "4000");
  assertEquals(suggestExpenseAccount(null, null), "4000");
});

// ─── buildJournalPreview ────────────────────────────────────────────────────────

function makeLine(overrides: Partial<{
  expense_account: string;
  vat_treatment: VatTreatment;
  net_amount: number;
  vat_amount: number;
  gross_amount: number;
  description: string;
}> = {}) {
  return {
    expense_account: overrides.expense_account ?? "6540",
    vat_treatment: overrides.vat_treatment ?? "domestic_deductible",
    net_amount: overrides.net_amount ?? 100,
    vat_amount: overrides.vat_amount ?? 25,
    gross_amount: overrides.gross_amount ?? 125,
    description: overrides.description ?? "Test",
  };
}

Deno.test("buildJournalPreview — domestic deductible creates expense + VAT + credit lines", () => {
  const lines = [makeLine({ vat_treatment: "domestic_deductible", net_amount: 100, vat_amount: 25, gross_amount: 125 })];
  const result = buildJournalPreview(lines, "owner_paid", "Test purchase");

  assertEquals(result.length, 3);
  // Debit expense
  assertEquals(result[0].account, "6540");
  assertEquals(result[0].debit, 100);
  assertEquals(result[0].credit, 0);
  // Debit input VAT
  assertEquals(result[1].account, "2641");
  assertEquals(result[1].debit, 25);
  assertEquals(result[1].credit, 0);
  // Credit payment
  assertEquals(result[2].account, "2018");
  assertEquals(result[2].debit, 0);
  assertEquals(result[2].credit, 125);
});

Deno.test("buildJournalPreview — domestic deductible balances (debit == credit)", () => {
  const lines = [makeLine({ vat_treatment: "domestic_deductible", net_amount: 473, vat_amount: 118.25, gross_amount: 591.25 })];
  const result = buildJournalPreview(lines, "owner_paid", "");
  const totalDebit = result.reduce((s, l) => s + l.debit, 0);
  const totalCredit = result.reduce((s, l) => s + l.credit, 0);
  assertEquals(Math.abs(totalDebit - totalCredit) < 0.01, true, `Debit ${totalDebit} != Credit ${totalCredit}`);
});

Deno.test("buildJournalPreview — reverse charge EU services creates 4 lines with neutral VAT", () => {
  const lines = [makeLine({ vat_treatment: "reverse_charge_eu_services", net_amount: 95, vat_amount: 0, gross_amount: 95 })];
  const result = buildJournalPreview(lines, "owner_paid", "RC purchase");

  assertEquals(result.length, 4);
  // Expense debit
  assertEquals(result[0].account, "6540");
  assertEquals(result[0].debit, 95);
  // Output VAT credit (2614)
  assertEquals(result[1].account, "2614");
  assertEquals(result[1].credit, 23.75); // 95 * 0.25
  // Input VAT debit (2645)
  assertEquals(result[2].account, "2645");
  assertEquals(result[2].debit, 23.75);
  // Payment credit
  assertEquals(result[3].account, "2018");
  assertEquals(result[3].credit, 95);
});

Deno.test("buildJournalPreview — reverse charge EU services balances (debit == credit)", () => {
  const lines = [makeLine({ vat_treatment: "reverse_charge_eu_services", net_amount: 97, vat_amount: 0, gross_amount: 97 })];
  const result = buildJournalPreview(lines, "owner_paid", "");
  const totalDebit = result.reduce((s, l) => s + l.debit, 0);
  const totalCredit = result.reduce((s, l) => s + l.credit, 0);
  assertEquals(Math.abs(totalDebit - totalCredit) < 0.01, true, `Debit ${totalDebit} != Credit ${totalCredit}`);
});

Deno.test("buildJournalPreview — non-deductible puts gross to expense", () => {
  const lines = [makeLine({ vat_treatment: "non_deductible", net_amount: 100, vat_amount: 25, gross_amount: 125 })];
  const result = buildJournalPreview(lines, "company_bank", "");

  assertEquals(result.length, 2);
  assertEquals(result[0].debit, 125); // full gross
  assertEquals(result[1].account, "1930"); // company bank
  assertEquals(result[1].credit, 125);
});

Deno.test("buildJournalPreview — no_vat uses net amount", () => {
  const lines = [makeLine({ vat_treatment: "no_vat", net_amount: 200, vat_amount: 0, gross_amount: 200 })];
  const result = buildJournalPreview(lines, "owner_paid", "");

  assertEquals(result.length, 2);
  assertEquals(result[0].debit, 200);
  assertEquals(result[1].credit, 200);
});

Deno.test("buildJournalPreview — needs_review uses gross amount", () => {
  const lines = [makeLine({ vat_treatment: "needs_review", net_amount: 100, vat_amount: 25, gross_amount: 125 })];
  const result = buildJournalPreview(lines, "owner_paid", "");

  assertEquals(result.length, 2);
  assertEquals(result[0].debit, 125); // uses gross for needs_review
  assertEquals(result[1].credit, 125);
});

Deno.test("buildJournalPreview — needs_review with unknown account shows warning name", () => {
  const lines = [makeLine({ expense_account: "9999", vat_treatment: "needs_review", net_amount: 100, vat_amount: 25, gross_amount: 125 })];
  const result = buildJournalPreview(lines, "owner_paid", "");

  assertEquals(result[0].accountName.includes("⚠"), true);
});

Deno.test("buildJournalPreview — multiple lines sum correctly", () => {
  const lines = [
    makeLine({ vat_treatment: "domestic_deductible", net_amount: 100, vat_amount: 25, gross_amount: 125 }),
    makeLine({ vat_treatment: "domestic_deductible", net_amount: 200, vat_amount: 50, gross_amount: 250 }),
  ];
  const result = buildJournalPreview(lines, "owner_paid", "");
  const totalDebit = result.reduce((s, l) => s + l.debit, 0);
  const totalCredit = result.reduce((s, l) => s + l.credit, 0);
  assertEquals(Math.abs(totalDebit - totalCredit) < 0.01, true);
  assertEquals(totalCredit, 375); // 125 + 250
});

Deno.test("buildJournalPreview — empty lines returns empty", () => {
  const result = buildJournalPreview([], "owner_paid", "");
  assertEquals(result.length, 0);
});

// ─── getPurchaseBlockers ────────────────────────────────────────────────────────

function makePurchase(overrides: Partial<{
  status: string;
  document_quality_status: string;
  vat_evidence_status: string;
  supplier_id: string | null;
  lines: Array<{ vat_treatment: string; net_amount: number; vat_amount: number; gross_amount: number }>;
  gross_amount: number;
  net_amount: number;
  vat_amount: number;
}> = {}) {
  return {
    status: overrides.status ?? "draft",
    document_quality_status: overrides.document_quality_status ?? "sufficient",
    vat_evidence_status: overrides.vat_evidence_status ?? "sufficient",
    supplier_id: overrides.supplier_id !== undefined ? overrides.supplier_id : "supplier-1",
    lines: overrides.lines ?? [{ vat_treatment: "domestic_deductible", net_amount: 100, vat_amount: 25, gross_amount: 125 }],
    gross_amount: overrides.gross_amount ?? 125,
    net_amount: overrides.net_amount ?? 100,
    vat_amount: overrides.vat_amount ?? 25,
  };
}

Deno.test("getPurchaseBlockers — valid purchase returns no blockers", () => {
  const blockers = getPurchaseBlockers(makePurchase());
  assertEquals(blockers.length, 0);
});

Deno.test("getPurchaseBlockers — missing supplier is an error", () => {
  const blockers = getPurchaseBlockers(makePurchase({ supplier_id: null }));
  const errors = blockers.filter(b => b.type === "error");
  assertEquals(errors.length >= 1, true);
  assertEquals(errors.some(e => e.message.includes("Leverantör")), true);
});

Deno.test("getPurchaseBlockers — no lines is an error", () => {
  const blockers = getPurchaseBlockers(makePurchase({ lines: [], gross_amount: 0, net_amount: 0, vat_amount: 0 }));
  assertEquals(blockers.some(b => b.type === "error" && b.message.includes("rader")), true);
});

Deno.test("getPurchaseBlockers — needs_review VAT treatment is an error", () => {
  const blockers = getPurchaseBlockers(makePurchase({
    lines: [{ vat_treatment: "needs_review", net_amount: 100, vat_amount: 25, gross_amount: 125 }],
  }));
  assertEquals(blockers.some(b => b.type === "error" && b.message.includes("klassificerad")), true);
});

Deno.test("getPurchaseBlockers — line total mismatch is an error", () => {
  const blockers = getPurchaseBlockers(makePurchase({
    lines: [{ vat_treatment: "domestic_deductible", net_amount: 80, vat_amount: 20, gross_amount: 100 }],
    gross_amount: 200, // mismatch
  }));
  assertEquals(blockers.some(b => b.type === "error" && b.message.includes("totalbelopp")), true);
});

Deno.test("getPurchaseBlockers — insufficient document quality is a warning", () => {
  const blockers = getPurchaseBlockers(makePurchase({ document_quality_status: "insufficient" }));
  const warnings = blockers.filter(b => b.type === "warning");
  assertEquals(warnings.length >= 1, true);
});

Deno.test("getPurchaseBlockers — insufficient VAT evidence with deductible VAT is an error", () => {
  const blockers = getPurchaseBlockers(makePurchase({
    vat_evidence_status: "insufficient",
    lines: [{ vat_treatment: "domestic_deductible", net_amount: 100, vat_amount: 25, gross_amount: 125 }],
  }));
  assertEquals(blockers.some(b => b.type === "error" && b.message.includes("underlag")), true);
});

Deno.test("getPurchaseBlockers — insufficient VAT evidence with reverse charge EU services is not an error", () => {
  const blockers = getPurchaseBlockers(makePurchase({
    vat_evidence_status: "insufficient",
    lines: [{ vat_treatment: "reverse_charge_eu_services", net_amount: 100, vat_amount: 0, gross_amount: 100 }],
    gross_amount: 100,
    net_amount: 100,
    vat_amount: 0,
  }));
  // Should not produce an error about VAT evidence for reverse charge
  assertEquals(blockers.some(b => b.type === "error" && b.message.includes("underlag")), false);
});
