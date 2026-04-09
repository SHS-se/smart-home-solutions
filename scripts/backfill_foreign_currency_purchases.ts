import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import {
  allocateConvertedLineAmounts,
  buildExchangeSnapshot,
  buildPurchasePersistence,
  describeJournalOriginalAmount,
  getPurchaseExchangeSnapshot,
  nearlyEqual,
  normalizeCurrency,
  parseAmount,
} from "../src/lib/accounting-fx.ts";
import { buildJournalPreview } from "../src/lib/accounting-utils.ts";
import type { PaymentSource, VatTreatment } from "../src/lib/accounting-utils.ts";
import { fetchEcbExchangeRates } from "../src/lib/ecb-rates.ts";

type JsonRecord = Record<string, unknown>;

interface PurchaseLineRow extends JsonRecord {
  id: string;
  expense_account: string | null;
  vat_treatment: string | null;
  net_amount: number | string | null;
  vat_amount: number | string | null;
  gross_amount: number | string | null;
  description: string | null;
}

interface PurchaseRow extends JsonRecord {
  id: string;
  currency: string;
  original_currency: string | null;
  document_date: string;
  description: string | null;
  payment_source: string;
  verification_id: string | null;
  gross_amount: number | string | null;
  net_amount: number | string | null;
  vat_amount: number | string | null;
  original_gross_amount: number | string | null;
  original_net_amount: number | string | null;
  original_vat_amount: number | string | null;
  lines: PurchaseLineRow[];
}

interface JournalRow extends JsonRecord {
  id: string;
  debit: number;
  credit: number;
}

const SUPABASE_URL = Deno.env.get("SUPABASE_URL") || Deno.env.get("VITE_SUPABASE_URL");
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");

if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
  throw new Error("SUPABASE_URL/VITE_SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY are required");
}

const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);

function quarterFromDate(isoDate: string): { year: number; quarter: number } {
  const [year, month] = isoDate.split("-").map(Number);
  return {
    year,
    quarter: Math.floor((month - 1) / 3) + 1,
  };
}

function hasBrokenJournalAmounts(journalLines: JournalRow[], snapshot: ReturnType<typeof getPurchaseExchangeSnapshot>): boolean {
  if (snapshot.originalCurrency === "SEK") return false;

  return journalLines.some((line) => {
    const value = Number(line.debit) > 0 ? Number(line.debit) : Number(line.credit);
    return nearlyEqual(value, snapshot.originalGross) || nearlyEqual(value, snapshot.originalNet) || nearlyEqual(value, snapshot.originalVat);
  });
}

function isPurchaseBroken(
  purchase: PurchaseRow,
  expectedSnapshot: ReturnType<typeof buildExchangeSnapshot>,
  journalLines: JournalRow[],
): boolean {
  const stored = getPurchaseExchangeSnapshot(purchase);
  return (
    stored.exchangeRateSource === "LEGACY_UNCONVERTED" ||
    !stored.exchangeRate ||
    !stored.exchangeRateDate ||
    !nearlyEqual(stored.convertedGrossSek, expectedSnapshot.convertedGrossSek) ||
    !nearlyEqual(stored.convertedNetSek, expectedSnapshot.convertedNetSek) ||
    !nearlyEqual(stored.convertedVatSek, expectedSnapshot.convertedVatSek) ||
    hasBrokenJournalAmounts(journalLines, stored)
  );
}

const { data: purchases, error: purchasesError } = await supabase
  .from("acc_purchases")
  .select("*, lines:acc_purchase_lines(*), verification:acc_verifications(id, verification_number)")
  .in("currency", ["EUR", "USD"])
  .order("document_date", { ascending: true });

if (purchasesError) {
  throw purchasesError;
}

const purchaseRows = (purchases || []) as PurchaseRow[];
if (purchaseRows.length === 0) {
  console.log("No EUR/USD purchases found");
  Deno.exit(0);
}

const uniqueRequests = Array.from(new Map(
  purchaseRows.map((purchase) => {
    const currency = normalizeCurrency(purchase.original_currency || purchase.currency);
    return [`${currency}:${purchase.document_date}`, { currency, documentDate: purchase.document_date }];
  }),
).values());
const lookupResults = await fetchEcbExchangeRates(uniqueRequests);
const lookupMap = new Map(uniqueRequests.map((request, index) => [`${request.currency}:${request.documentDate}`, lookupResults[index]]));

let backfilledPurchases = 0;
const affectedPeriods = new Set<string>();

for (const purchase of purchaseRows) {
  const originalCurrency = normalizeCurrency(purchase.original_currency || purchase.currency);
  const lookup = lookupMap.get(`${originalCurrency}:${purchase.document_date}`);
  if (!lookup) {
    throw new Error(`Missing ECB lookup for ${purchase.id} (${originalCurrency} ${purchase.document_date})`);
  }

  const originalAmounts = {
    gross: parseAmount(purchase.original_gross_amount ?? purchase.gross_amount),
    net: parseAmount(purchase.original_net_amount ?? purchase.net_amount),
    vat: parseAmount(purchase.original_vat_amount ?? purchase.vat_amount),
  };

  const expectedSnapshot = buildExchangeSnapshot({
    documentDate: purchase.document_date,
    currency: originalCurrency,
    originalAmounts,
    lookup,
  });

  let journalLines: JournalRow[] = [];
  if (purchase.verification_id) {
    const { data: journalData, error: journalError } = await supabase
      .from("acc_journal_lines")
      .select("*")
      .eq("verification_id", purchase.verification_id)
      .order("sort_order");
    if (journalError) throw journalError;
    journalLines = (journalData || []) as JournalRow[];
  }

  if (!isPurchaseBroken(purchase, expectedSnapshot, journalLines)) {
    continue;
  }

  const lineRows = allocateConvertedLineAmounts(
    (purchase.lines || []).map((line) => ({
      ...line,
      expense_account: String(line.expense_account || "4000"),
      vat_treatment: String(line.vat_treatment || "needs_review") as VatTreatment,
      net_amount: parseAmount(line.net_amount),
      vat_amount: parseAmount(line.vat_amount),
      gross_amount: parseAmount(line.gross_amount),
      description: String(line.description || purchase.description || ""),
    })),
    expectedSnapshot,
  );

  const { error: purchaseUpdateError } = await supabase
    .from("acc_purchases")
    .update(buildPurchasePersistence(expectedSnapshot))
    .eq("id", purchase.id);
  if (purchaseUpdateError) throw purchaseUpdateError;

  for (const line of lineRows) {
    const { error: lineUpdateError } = await supabase
      .from("acc_purchase_lines")
      .update({
        net_amount: line.net_amount,
        vat_amount: line.vat_amount,
        gross_amount: line.gross_amount,
      })
      .eq("id", String(line.id));
    if (lineUpdateError) throw lineUpdateError;
  }

  if (purchase.verification_id) {
    const { error: deleteError } = await supabase
      .from("acc_journal_lines")
      .delete()
      .eq("verification_id", purchase.verification_id);
    if (deleteError) throw deleteError;

    const preview = buildJournalPreview(
      lineRows.map((line) => ({
        expense_account: line.expense_account,
        vat_treatment: line.vat_treatment,
        net_amount: line.net_amount,
        vat_amount: line.vat_amount,
        gross_amount: line.gross_amount,
        description: line.description || purchase.description || "",
      })),
      purchase.payment_source as PaymentSource,
      purchase.description || "",
    );

    const primaryVatTreatment = (lineRows[0]?.vat_treatment as VatTreatment | undefined) || "needs_review";
    const rebuiltLines = preview.map((line, index) => {
      let originalAmount: number | null = null;
      if (line.account === "2641") {
        originalAmount = describeJournalOriginalAmount("input_vat", primaryVatTreatment, expectedSnapshot);
      } else if (line.account === "2614" || line.account === "2645") {
        originalAmount = describeJournalOriginalAmount("reverse_charge_vat", primaryVatTreatment, expectedSnapshot);
      } else if (line.account === "2018" || line.account === "1930") {
        originalAmount = describeJournalOriginalAmount("payment", primaryVatTreatment, expectedSnapshot);
      } else if (line.debit > 0) {
        originalAmount = describeJournalOriginalAmount("expense", primaryVatTreatment, expectedSnapshot);
      }

      return {
        verification_id: purchase.verification_id,
        account: line.account,
        account_name: line.accountName,
        description: line.description,
        debit: line.debit,
        credit: line.credit,
        sort_order: index,
        original_currency: expectedSnapshot.originalCurrency,
        original_amount: originalAmount,
        exchange_rate_source: expectedSnapshot.exchangeRateSource,
        exchange_rate_date: expectedSnapshot.exchangeRateDate,
        exchange_rate: expectedSnapshot.exchangeRate,
        exchange_rate_overridden: expectedSnapshot.exchangeRateOverridden,
        converted_amount_sek: line.debit > 0 ? line.debit : line.credit,
      };
    });

    const { error: insertError } = await supabase
      .from("acc_journal_lines")
      .insert(rebuiltLines);
    if (insertError) throw insertError;
  }

  const period = quarterFromDate(purchase.document_date);
  affectedPeriods.add(`${period.year}:${period.quarter}`);
  backfilledPurchases += 1;
  console.log(`Backfilled ${purchase.id} (${expectedSnapshot.originalCurrency} ${expectedSnapshot.originalGross} -> SEK ${expectedSnapshot.convertedGrossSek})`);
}

for (const periodKey of affectedPeriods) {
  const [year, quarter] = periodKey.split(":").map(Number);
  const { error } = await supabase
    .from("acc_vat_periods")
    .update({
      status: "open",
      snapshot_data: null,
      snapshot_created_at: null,
      snapshot_created_by: null,
      snapshot_hash: null,
    })
      .eq("year", year)
      .eq("quarter", quarter);
  if (error) throw error;
}

console.log(`Backfilled ${backfilledPurchases} foreign-currency purchases`);
