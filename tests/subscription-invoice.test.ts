// Tests for the subscription own-invoice builder: the VAT split that turns the
// VAT-inclusive Stripe charge into the ex-VAT line our invoices store, and the
// idempotent create→finalize→pay sequence (driven against a stub client).

import { assert, assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import {
  splitVatInclusive,
  buildSubscriptionInvoice,
} from "../supabase/functions/_shared/subscription-invoice.ts";

// ─── splitVatInclusive ───────────────────────────────────────────────────────

Deno.test("splitVatInclusive splits 249 kr incl 25% into 199.20 + 49.80", () => {
  const a = splitVatInclusive(249, 25);
  assertEquals(a.net, 199.2);
  assertEquals(a.vat, 49.8);
  assertEquals(a.gross, 249);
});

Deno.test("splitVatInclusive: net + vat always reconstructs the gross", () => {
  for (const gross of [100, 249, 99.99, 1, 12345.67]) {
    const a = splitVatInclusive(gross, 25);
    assertEquals(Math.round((a.net + a.vat) * 100) / 100, a.gross);
  }
});

// ─── buildSubscriptionInvoice ────────────────────────────────────────────────

interface Recorded {
  invoiceInsert: Record<string, unknown> | null;
  lineInsert: Record<string, unknown> | null;
  paymentInsert: Record<string, unknown> | null;
  invoiceUpdate: Record<string, unknown> | null;
  rpc: { name: string; params: Record<string, unknown> } | null;
}

/** Stub Supabase client: records writes, returns canned reads. `existingInvoice`
 *  drives the idempotency branch. */
function stubClient(existingInvoice: { id: string; invoice_number: string | null } | null) {
  const rec: Recorded = {
    invoiceInsert: null,
    lineInsert: null,
    paymentInsert: null,
    invoiceUpdate: null,
    rpc: null,
  };
  const client = {
    from(table: string) {
      return {
        select() {
          return {
            eq() {
              return this;
            },
            maybeSingle() {
              return Promise.resolve({
                data: table === "invoices" ? existingInvoice : null,
                error: null,
              });
            },
          };
        },
        insert(payload: Record<string, unknown>) {
          if (table === "invoices") rec.invoiceInsert = payload;
          else if (table === "invoice_line_items") rec.lineInsert = payload;
          else if (table === "invoice_payments") rec.paymentInsert = payload;
          return {
            select() {
              return { single: () => Promise.resolve({ data: { id: "inv-new" }, error: null }) };
            },
            then(onF: (v: unknown) => unknown, onR?: (e: unknown) => unknown) {
              return Promise.resolve({ error: null }).then(onF, onR);
            },
          };
        },
        update(payload: Record<string, unknown>) {
          if (table === "invoices") rec.invoiceUpdate = payload;
          return { eq: () => Promise.resolve({ error: null }) };
        },
      };
    },
    rpc(name: string, params: Record<string, unknown>) {
      rec.rpc = { name, params };
      return Promise.resolve({ data: { invoice_number: "TIN-000010" }, error: null });
    },
    _rec: rec,
  };
  return client;
}

const ARGS = {
  customerId: "cust-1",
  stripeInvoiceId: "in_test_123",
  grossAmount: 249,
  description: "Månadsabonnemang Smart Home Solutions – juni 2026",
  paymentDate: "2026-06-27",
  appEnv: "test" as const,
};

Deno.test("buildSubscriptionInvoice creates, finalizes and pays a fresh invoice", async () => {
  const client = stubClient(null);
  const res = await buildSubscriptionInvoice(
    client as unknown as Parameters<typeof buildSubscriptionInvoice>[0],
    ARGS,
  );
  assertEquals(res.created, true);
  assertEquals(res.invoiceNumber, "TIN-000010");

  const rec = client._rec;
  // Draft invoice carries the Stripe linkage + test flag.
  assertEquals(rec.invoiceInsert?.customer_id, "cust-1");
  assertEquals(rec.invoiceInsert?.status, "draft");
  assertEquals(rec.invoiceInsert?.stripe_invoice_id, "in_test_123");
  assertEquals(rec.invoiceInsert?.is_test, true);
  // Line item is ex-VAT with a separate tax_rate.
  assertEquals(rec.lineInsert?.unit_price, 199.2);
  assertEquals(rec.lineInsert?.tax_rate, 25);
  assertEquals(rec.lineInsert?.line_type, "travel_other");
  // Finalize via the DB function.
  assertEquals(rec.rpc?.name, "finalize_local_invoice");
  assertEquals(rec.rpc?.params.p_invoice_id, "inv-new");
  assertEquals(rec.rpc?.params.p_app_env, "test");
  // Payment is the gross amount, posted as a Stripe payment.
  assertEquals(rec.paymentInsert?.amount, 249);
  assertEquals(rec.paymentInsert?.method, "stripe");
  assertEquals(rec.paymentInsert?.reference, "in_test_123");
  // Invoice marked paid.
  assertEquals(rec.invoiceUpdate?.status, "paid");
});

Deno.test("buildSubscriptionInvoice is idempotent on stripe_invoice_id", async () => {
  const client = stubClient({ id: "inv-existing", invoice_number: "TIN-000009" });
  const res = await buildSubscriptionInvoice(
    client as unknown as Parameters<typeof buildSubscriptionInvoice>[0],
    ARGS,
  );
  assertEquals(res.created, false);
  assertEquals(res.invoiceId, "inv-existing");
  assertEquals(res.invoiceNumber, "TIN-000009");
  // Nothing was written.
  assert(client._rec.invoiceInsert === null);
  assert(client._rec.rpc === null);
  assert(client._rec.paymentInsert === null);
});
