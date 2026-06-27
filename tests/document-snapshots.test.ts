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
  assertRejects,
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
  loadInvoiceDocumentData,
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
  const c = parseCustomerSnapshot({
    name: "Alice",
    email: "alice@example.com",
    phone: "+46 70 111 22 33",
    street: "Storgatan 1",
    postcode: "12345",
    city: "Täby",
  });
  assertExists(c);
  assertEquals(c!.name, "Alice");
  assertEquals(c!.email, "alice@example.com");
  assertEquals(c!.phone, "+46 70 111 22 33");
  assertEquals(c!.street, "Storgatan 1");
  assertEquals(c!.city, "Täby");
});

Deno.test("parseCustomerSnapshot coerces blank/missing email + phone to null", () => {
  const c = parseCustomerSnapshot({ name: "Alice", email: "" });
  assertExists(c);
  assertEquals(c!.email, null); // blank -> null
  assertEquals(c!.phone, null); // missing key -> null
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

Deno.test("buildInvoiceQrPayload emits the UsingQR invoice format", () => {
  const payload = buildInvoiceQrPayload({
    bankgiroNumber: "5307-7913",
    orgNumber: "556000-0000",
    payeeName: "Philip Cheong",
    invoiceNumber: "TIN-000005",
    invoiceDate: "2026-06-07T09:30:00Z",
    amount: 1893.75,
    dueDate: "2026-07-07",
  });
  assertExists(payload);
  const parsed = JSON.parse(payload!);
  assertEquals(parsed.uqr, 1);
  assertEquals(parsed.tp, 1);
  assertEquals(parsed.nme, "Philip Cheong");
  assertEquals(parsed.cid, "556000-0000");
  assertEquals(parsed.iref, "TIN-000005");
  assertEquals(parsed.idt, "20260607");
  assertEquals(parsed.ddt, "20260707");
  assertEquals(parsed.due, 1893.75);
  assertEquals(parsed.pt, "BG");
  assertEquals(parsed.acc, "5307-7913");
});

Deno.test("buildInvoiceQrPayload omits dates it cannot parse", () => {
  const payload = buildInvoiceQrPayload({
    bankgiroNumber: "5307-7913",
    orgNumber: "556000-0000",
    payeeName: "Co",
    invoiceNumber: "IN-1",
    invoiceDate: null,
    amount: 10,
    dueDate: null,
  });
  const parsed = JSON.parse(payload!);
  assertEquals("idt" in parsed, false);
  assertEquals("ddt" in parsed, false);
});

Deno.test("buildInvoiceQrPayload is null without bankgiro or invoice number", () => {
  const base = {
    orgNumber: "556000-0000",
    payeeName: "Co",
    invoiceDate: null,
    amount: 10,
    dueDate: null,
  };
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

// ─── loadInvoiceDocumentData (end-to-end resolution of every rendered field) ──
//
// This is the single function that assembles everything the invoice PDF + the
// on-screen document view render. These tests pin down each field — buyer
// (name/email/phone/address), seller, line items, totals, payments and payment
// details — and the draft(live) vs finalized(frozen-snapshot) precedence, so a
// regression in any rendered detail fails loudly here.

/** Stub Supabase client for loadInvoiceDocumentData: resolves each table's
 *  terminal call (single/maybeSingle/order) to the canned result for that table. */
function stubDocClient(byTable: Record<string, { data: unknown; error?: unknown }>) {
  return {
    from(table: string) {
      const result = byTable[table] ?? { data: null, error: null };
      const builder = {
        select: () => builder,
        eq: () => builder,
        order: () => Promise.resolve(result),
        single: () => Promise.resolve(result),
        maybeSingle: () => Promise.resolve(result),
      };
      return builder;
    },
  } as unknown as Parameters<typeof loadInvoiceDocumentData>[0];
}

// A finalized invoice: both seller (business_snapshot) and buyer
// (customer_snapshot) are frozen, and the live customer row holds DIFFERENT
// values that must be ignored.
const FROZEN_INVOICE_ROW = {
  id: "inv-1",
  invoice_number: "IN-000002",
  status: "open",
  due_date: "2026-07-26",
  currency: "SEK",
  customer_id: "cust-1",
  created_at: "2026-06-26T10:00:00Z",
  finalized_at: "2026-06-26T12:00:00Z",
  issued_at: "2026-06-26T12:00:00Z",
  paid_at: null,
  voided_at: null,
  quote_number: "OFF-000009",
  business_snapshot: FULL_ROW,
  customer_snapshot: {
    name: "Sven Titusson",
    email: "sven@example.com",
    phone: "+46 70 555 66 77",
    street: "Porfyrvägen 3",
    postcode: "187 34",
    city: "Täby",
  },
  customer: {
    name: "LIVE Name (edited later)",
    contact_email: "live@changed.example",
    contact_phone: "000",
    billing_same_as_site: true,
    site_street: "LIVE street",
    site_postcode: "00000",
    site_city: "LIVE city",
    billing_street: null,
    billing_postcode: null,
    billing_city: null,
  },
};

function frozenClient() {
  return stubDocClient({
    invoices: { data: FROZEN_INVOICE_ROW },
    invoice_line_items: {
      data: [
        // String-typed numerics (as Supabase returns numeric columns) must be coerced.
        { id: "li-1", line_type: "hardware", description: "Dream Router 7", quantity: "2", unit_price: "1500.5", tax_rate: "25", sku: "UDR7", category: "net", sort_order: 0 },
        { id: "li-2", line_type: "labor", description: "Installation", quantity: 1, unit_price: 875.25, tax_rate: 25, sku: null, category: null, sort_order: 1 },
      ],
    },
    invoice_computed_totals: { data: { subtotal: 3901.0, tax: 975.25, total: 4876.25 } },
    invoice_payments: {
      data: [
        { id: "p-1", payment_date: "2026-06-27", amount: "1000", method: "bankgiro", reference: "IN-000002", note: null, created_at: "2026-06-27T08:00:00Z" },
      ],
    },
  });
}

Deno.test("loadInvoiceDocumentData maps invoice metadata", async () => {
  const doc = await loadInvoiceDocumentData(frozenClient(), "inv-1");
  assertEquals(doc.id, "inv-1");
  assertEquals(doc.invoice_number, "IN-000002");
  assertEquals(doc.status, "open");
  assertEquals(doc.due_date, "2026-07-26");
  assertEquals(doc.currency, "SEK");
  assertEquals(doc.quote_number, "OFF-000009");
  assertEquals(doc.issued_at, "2026-06-26T12:00:00Z");
  assertEquals(doc.finalized_at, "2026-06-26T12:00:00Z");
  assertEquals(doc.paid_at, null);
});

Deno.test("loadInvoiceDocumentData renders the frozen buyer, not the live customer", async () => {
  const doc = await loadInvoiceDocumentData(frozenClient(), "inv-1");
  assertEquals(doc.customer_name, "Sven Titusson");
  assertEquals(doc.customer_email, "sven@example.com");
  assertEquals(doc.customer_phone, "+46 70 555 66 77");
  assertEquals(doc.customer_address?.street, "Porfyrvägen 3");
  assertEquals(doc.customer_address?.postcode, "187 34");
  assertEquals(doc.customer_address?.city, "Täby");
});

Deno.test("loadInvoiceDocumentData renders the frozen seller (business_snapshot)", async () => {
  const doc = await loadInvoiceDocumentData(frozenClient(), "inv-1");
  assertEquals(doc.seller.name, "Frozen Co AB");
  assertEquals(doc.seller.orgNumber, "556000-0000");
  assertEquals(doc.seller.vatNumber, "SE556000000001");
  assertEquals(doc.seller.bankgiroNumber, "5307-7913");
});

Deno.test("loadInvoiceDocumentData coerces line item numerics and keeps order", async () => {
  const doc = await loadInvoiceDocumentData(frozenClient(), "inv-1");
  assertEquals(doc.line_items.length, 2);
  const [first, second] = doc.line_items;
  assertEquals(first.id, "li-1");
  assertEquals(first.quantity, 2); // "2" -> 2
  assertEquals(first.unit_price, 1500.5); // "1500.5" -> 1500.5
  assertEquals(first.tax_rate, 25);
  assertEquals(typeof first.quantity, "number");
  assertEquals(second.line_type, "labor");
  assertEquals(second.unit_price, 875.25);
});

Deno.test("loadInvoiceDocumentData carries totals and coerces payments", async () => {
  const doc = await loadInvoiceDocumentData(frozenClient(), "inv-1");
  assertEquals(doc.subtotal, 3901.0);
  assertEquals(doc.tax, 975.25);
  assertEquals(doc.total, 4876.25);
  assertEquals(doc.payments.length, 1);
  assertEquals(doc.payments[0].amount, 1000); // "1000" -> 1000
  assertEquals(typeof doc.payments[0].amount, "number");
  assertEquals(doc.payments[0].method, "bankgiro");
});

Deno.test("loadInvoiceDocumentData builds payment details + UsingQR from frozen data", async () => {
  const doc = await loadInvoiceDocumentData(frozenClient(), "inv-1");
  const pd = doc.payment_details;
  assertEquals(pd.bankgiro_number, "5307-7913");
  assertEquals(pd.payee_name, "Philip Cheong");
  assertEquals(pd.payment_reference, "IN-000002");
  assertEquals(pd.amount, 4876.25); // mirrors the computed total
  assertEquals(pd.due_date, "2026-07-26");
  assertExists(pd.qr_data_url);
  const qr = JSON.parse(pd.qr_payload!);
  assertEquals(qr.acc, "5307-7913");
  assertEquals(qr.cid, "556000-0000");
  assertEquals(qr.iref, "IN-000002");
  assertEquals(qr.due, 4876.25);
  assertEquals(qr.idt, "20260626"); // from issued_at
  assertEquals(qr.ddt, "20260726"); // from due_date
});

// A draft invoice: no snapshots, so buyer + seller resolve from live data.
const LIVE_SETTINGS_ROW = {
  legal_name: "Live Co AB",
  org_number: "559999-9999",
  vat_number: "SE559999999901",
  bankgiro_number: "1234-5678",
  payee_name: "Live Co AB",
};

const DRAFT_INVOICE_ROW = {
  id: "inv-2",
  invoice_number: null, // drafts may not have a number yet
  status: "draft",
  due_date: "2026-08-01",
  currency: "SEK",
  customer_id: "cust-2",
  created_at: "2026-06-27T09:00:00Z",
  finalized_at: null,
  issued_at: null,
  paid_at: null,
  voided_at: null,
  quote_number: null,
  business_snapshot: null,
  customer_snapshot: null,
  customer: {
    name: "Live Buyer AB",
    contact_email: "buyer@live.example",
    contact_phone: "+46 8 123 456",
    billing_same_as_site: false,
    site_street: "Site St 1",
    site_postcode: "11111",
    site_city: "Sitetown",
    billing_street: "Billing Rd 9",
    billing_postcode: "22222",
    billing_city: "Billtown",
  },
};

function draftClient(customerOverrides: Record<string, unknown> = {}) {
  return stubDocClient({
    invoices: { data: { ...DRAFT_INVOICE_ROW, customer: { ...DRAFT_INVOICE_ROW.customer, ...customerOverrides } } },
    business_settings: { data: LIVE_SETTINGS_ROW },
    invoice_line_items: { data: [] },
    invoice_computed_totals: { data: null },
    invoice_payments: { data: [] },
  });
}

Deno.test("loadInvoiceDocumentData falls back to live buyer + seller for drafts", async () => {
  const doc = await loadInvoiceDocumentData(draftClient(), "inv-2");
  assertEquals(doc.invoice_number, null);
  assertEquals(doc.customer_name, "Live Buyer AB");
  assertEquals(doc.customer_email, "buyer@live.example");
  assertEquals(doc.customer_phone, "+46 8 123 456");
  // billing_same_as_site=false -> billing address wins.
  assertEquals(doc.customer_address?.street, "Billing Rd 9");
  assertEquals(doc.customer_address?.city, "Billtown");
  // Seller resolves from the live business_settings row.
  assertEquals(doc.seller.name, "Live Co AB");
  assertEquals(doc.seller.orgNumber, "559999-9999");
  assertEquals(doc.seller.bankgiroNumber, "1234-5678");
});

Deno.test("loadInvoiceDocumentData uses the site address when billing_same_as_site", async () => {
  const doc = await loadInvoiceDocumentData(draftClient({ billing_same_as_site: true }), "inv-2");
  assertEquals(doc.customer_address?.street, "Site St 1");
  assertEquals(doc.customer_address?.postcode, "11111");
  assertEquals(doc.customer_address?.city, "Sitetown");
});

Deno.test("loadInvoiceDocumentData zeroes missing totals and empty collections", async () => {
  const doc = await loadInvoiceDocumentData(draftClient(), "inv-2");
  assertEquals(doc.subtotal, 0);
  assertEquals(doc.tax, 0);
  assertEquals(doc.total, 0);
  assertEquals(doc.line_items, []);
  assertEquals(doc.payments, []);
});

Deno.test("loadInvoiceDocumentData omits the QR when there is no invoice number", async () => {
  const doc = await loadInvoiceDocumentData(draftClient(), "inv-2");
  // No invoice number yet -> no UsingQR payload, but bankgiro is still shown.
  assertEquals(doc.payment_details.qr_payload, null);
  assertEquals(doc.payment_details.qr_data_url, null);
  assertEquals(doc.payment_details.bankgiro_number, "1234-5678");
});

Deno.test("loadInvoiceDocumentData throws when the invoice is missing", async () => {
  const client = stubDocClient({ invoices: { data: null, error: { message: "no rows" } } });
  await assertRejects(() => loadInvoiceDocumentData(client, "missing"), Error, "Invoice not found");
});
