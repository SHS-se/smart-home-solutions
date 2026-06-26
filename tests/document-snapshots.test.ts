// Tests for the business-settings + document-snapshot logic that backs invoice
// immutability: finalized invoices must render the seller (business) and buyer
// (customer) details that were frozen onto them, not the live, mutable rows.
//
// These cover the pure resolution/mapping/fallback helpers. The DB-side capture
// (finalize_local_invoice business_snapshot + the freeze_customer_snapshot
// trigger) is integration-level and verified separately against the database.

import {
  assert,
  assertEquals,
  assertExists,
} from "https://deno.land/std@0.224.0/assert/mod.ts";
import {
  mapBusinessSettingsRow,
  businessSettingsFromSnapshot,
  loadBusinessSettings,
  loadInvoiceBusinessSettings,
  INVOICE_COMPANY,
} from "../supabase/functions/_shared/invoice-company.ts";
import {
  parseCustomerSnapshot,
  buildInvoiceQrPayload,
  buildInvoicePaymentDetails,
} from "../supabase/functions/_shared/invoice-document.ts";

// A complete business_settings row as stored in the DB / a business_snapshot.
const FULL_ROW = {
  legal_name: "Frozen Co AB",
  org_number: "556000-0000",
  vat_number: "SE556000000001",
  f_skatt_approved: true,
  address_street: "Frusna gatan 1",
  address_postcode: "111 22",
  address_city: "Frostad",
  address_country: "Sverige",
  contact_email: "hello@frozen.example",
  support_email: "support@frozen.example",
  contact_phone: "+46 70 000 00 00",
  website: "https://frozen.example",
  bankgiro_number: "5307-7913",
  payee_name: "Philip Cheong",
  iban: "SE00 0000",
  bic: "FROZSESS",
  bank_name: "Lunar",
  payment_terms_days: 14,
};

/** Minimal stub of the Supabase client used by the loaders: from(table) ->
 *  chainable select/eq/maybeSingle resolving to the canned result for `table`. */
function stubClient(byTable: Record<string, { data: unknown; error?: unknown }>) {
  return {
    from(table: string) {
      const result = byTable[table] ?? { data: null, error: null };
      const builder = {
        select: () => builder,
        eq: () => builder,
        maybeSingle: () => Promise.resolve(result),
      };
      return builder;
    },
  } as unknown as Parameters<typeof loadBusinessSettings>[0];
}

// ─── mapBusinessSettingsRow ──────────────────────────────────────────────────

Deno.test("mapBusinessSettingsRow maps every column", () => {
  const s = mapBusinessSettingsRow(FULL_ROW);
  assertEquals(s.name, "Frozen Co AB");
  assertEquals(s.orgNumber, "556000-0000");
  assertEquals(s.vatNumber, "SE556000000001");
  assertEquals(s.bankgiroNumber, "5307-7913");
  assertEquals(s.payeeName, "Philip Cheong");
  assertEquals(s.bankName, "Lunar");
  assertEquals(s.paymentTermsDays, 14);
  assertEquals(s.supportEmail, "support@frozen.example");
});

Deno.test("mapBusinessSettingsRow fills blanks from defaults", () => {
  const s = mapBusinessSettingsRow({ legal_name: "  ", bankgiro_number: "" });
  // Blank legal_name -> hard-coded default; blank bankgiro -> null (no env in test).
  assertEquals(s.name, INVOICE_COMPANY.name);
  assertEquals(s.bankgiroNumber, null);
  assertEquals(s.paymentTermsDays, 30);
});

Deno.test("mapBusinessSettingsRow: supportEmail falls back to contact_email", () => {
  const s = mapBusinessSettingsRow({ contact_email: "only@there.example", support_email: null });
  assertEquals(s.supportEmail, "only@there.example");
});

Deno.test("mapBusinessSettingsRow: payeeName falls back to legal_name", () => {
  const s = mapBusinessSettingsRow({ legal_name: "Acme AB", payee_name: null });
  assertEquals(s.payeeName, "Acme AB");
});

Deno.test("mapBusinessSettingsRow: f_skatt only false when explicitly false", () => {
  assertEquals(mapBusinessSettingsRow({ f_skatt_approved: false }).fSkattApproved, false);
  assertEquals(mapBusinessSettingsRow({ f_skatt_approved: true }).fSkattApproved, true);
  assertEquals(mapBusinessSettingsRow({}).fSkattApproved, true);
});

Deno.test("mapBusinessSettingsRow: non-numeric payment terms -> default 30", () => {
  assertEquals(mapBusinessSettingsRow({ payment_terms_days: "oops" }).paymentTermsDays, 30);
});

// ─── businessSettingsFromSnapshot (seller freeze) ────────────────────────────

Deno.test("businessSettingsFromSnapshot maps a frozen snapshot", () => {
  const s = businessSettingsFromSnapshot(FULL_ROW);
  assertExists(s);
  assertEquals(s!.bankgiroNumber, "5307-7913");
  assertEquals(s!.name, "Frozen Co AB");
});

Deno.test("businessSettingsFromSnapshot returns null without a usable snapshot", () => {
  assertEquals(businessSettingsFromSnapshot(null), null);
  assertEquals(businessSettingsFromSnapshot(undefined), null);
  assertEquals(businessSettingsFromSnapshot("not-an-object"), null);
});

// ─── loadBusinessSettings (live read) ────────────────────────────────────────

Deno.test("loadBusinessSettings maps the live row", async () => {
  const s = await loadBusinessSettings(stubClient({ business_settings: { data: FULL_ROW } }));
  assertEquals(s.bankgiroNumber, "5307-7913");
  assertEquals(s.payeeName, "Philip Cheong");
});

Deno.test("loadBusinessSettings falls back to defaults when row missing", async () => {
  const s = await loadBusinessSettings(stubClient({ business_settings: { data: null } }));
  assertEquals(s.name, INVOICE_COMPANY.name);
  assertEquals(s.bankgiroNumber, null);
});

// ─── loadInvoiceBusinessSettings (frozen-over-live preference) ────────────────

Deno.test("loadInvoiceBusinessSettings prefers the invoice's frozen snapshot over live", async () => {
  const client = stubClient({
    invoices: { data: { business_snapshot: { ...FULL_ROW, bankgiro_number: "FROZEN-001", legal_name: "Old Name AB" } } },
    business_settings: { data: { ...FULL_ROW, bankgiro_number: "LIVE-999", legal_name: "New Name AB" } },
  });
  const s = await loadInvoiceBusinessSettings(client, "inv-1");
  // Must be the frozen values, NOT the live ones.
  assertEquals(s.bankgiroNumber, "FROZEN-001");
  assertEquals(s.name, "Old Name AB");
});

Deno.test("loadInvoiceBusinessSettings falls back to live when no snapshot (draft/legacy)", async () => {
  const client = stubClient({
    invoices: { data: { business_snapshot: null } },
    business_settings: { data: { ...FULL_ROW, bankgiro_number: "LIVE-999" } },
  });
  const s = await loadInvoiceBusinessSettings(client, "inv-2");
  assertEquals(s.bankgiroNumber, "LIVE-999");
});

// ─── parseCustomerSnapshot (buyer freeze) ────────────────────────────────────

Deno.test("parseCustomerSnapshot reads a frozen buyer", () => {
  const c = parseCustomerSnapshot({ name: "Alice", street: "Storgatan 1", postcode: "12345", city: "Täby" });
  assertExists(c);
  assertEquals(c!.name, "Alice");
  assertEquals(c!.street, "Storgatan 1");
  assertEquals(c!.city, "Täby");
});

Deno.test("parseCustomerSnapshot returns null without a usable snapshot", () => {
  assertEquals(parseCustomerSnapshot(null), null);
  assertEquals(parseCustomerSnapshot(undefined), null);
  assertEquals(parseCustomerSnapshot("nope"), null);
});

Deno.test("parseCustomerSnapshot coerces blank fields to null", () => {
  const c = parseCustomerSnapshot({ name: "", street: "  X", postcode: null, city: undefined });
  assertExists(c);
  assertEquals(c!.name, null);
  assertEquals(c!.postcode, null);
});

// ─── buildInvoiceQrPayload ───────────────────────────────────────────────────

Deno.test("buildInvoiceQrPayload encodes the payment instruction", () => {
  const payload = buildInvoiceQrPayload({
    bankgiroNumber: "5307-7913",
    payeeName: "Philip Cheong",
    invoiceNumber: "TIN-000005",
    amount: 1893.75,
    currency: "SEK",
    dueDate: "2026-07-07",
  });
  assertExists(payload);
  assert(payload!.includes("BANKGIRO:5307-7913"));
  assert(payload!.includes("REFERENCE:TIN-000005"));
  assert(payload!.includes("AMOUNT:1893.75"));
});

Deno.test("buildInvoiceQrPayload is null without bankgiro or invoice number", () => {
  const base = { payeeName: "Co", amount: 10, currency: "SEK", dueDate: null };
  assertEquals(buildInvoiceQrPayload({ ...base, bankgiroNumber: null, invoiceNumber: "IN-1" }), null);
  assertEquals(buildInvoiceQrPayload({ ...base, bankgiroNumber: "123", invoiceNumber: null }), null);
});

// ─── buildInvoicePaymentDetails (uses frozen settings) ───────────────────────

Deno.test("buildInvoicePaymentDetails uses the provided settings' bankgiro + payee", async () => {
  const settings = businessSettingsFromSnapshot(FULL_ROW)!;
  const details = await buildInvoicePaymentDetails({
    invoiceNumber: "TIN-000005",
    amount: 1893.75,
    dueDate: "2026-07-07",
    currency: "SEK",
    settings,
  });
  assertEquals(details.bankgiro_number, "5307-7913");
  assertEquals(details.payee_name, "Philip Cheong");
  assert(details.manual_payment_instruction.includes("Betala till Bankgiro 5307-7913"));
  assertExists(details.qr_data_url); // QR is generated when a bankgiro exists
});

Deno.test("buildInvoicePaymentDetails explains when no bankgiro is configured", async () => {
  const settings = businessSettingsFromSnapshot({ ...FULL_ROW, bankgiro_number: "" })!;
  const details = await buildInvoicePaymentDetails({
    invoiceNumber: "TIN-000005",
    amount: 100,
    dueDate: null,
    currency: "SEK",
    settings,
  });
  assertEquals(details.bankgiro_number, null);
  assert(details.manual_payment_instruction.includes("inte konfigurerat"));
  assertEquals(details.qr_data_url, null);
});
