/// <reference lib="deno.ns" />

import { buildPurchaseDraftDefaults, createPurchaseDraft, type CreatePurchaseDraftParams } from './purchase-drafts.ts';
import { parseInvoiceText } from './invoice-parser.ts';
import { buildJournalPreview, type VatTreatment } from './accounting-utils.ts';
import fixtures from './fixtures/invoices-2026-q3.json' with { type: 'json' };
import { PurchaseDraftError } from './purchase-draft-error.ts';

function assertEqual(actual: unknown, expected: unknown, field: string): void {
  if (actual !== expected) throw new Error(`${field}: expected ${String(expected)}, got ${String(actual)}`);
}

function mockSupabase(updateError: { message: string; code: string } | null = null) {
  const inserts: Record<string, Record<string, unknown>[]> = {};
  const updates: Array<{ table: string; payload: Record<string, unknown>; id: string }> = [];
  const client = {
    from(table: string) {
      return {
        select() {
          return { eq: async () => ({ data: [], error: null }) };
        },
        update(payload: Record<string, unknown>) {
          return { eq: async (_field: string, id: string) => {
            updates.push({ table, payload, id });
            return { error: updateError };
          } };
        },
        insert(payload: Record<string, unknown>) {
          (inserts[table] ??= []).push(payload);
          return {
            error: null,
            select: () => ({ single: async () => ({ data: { id: `${table}-id`, ...payload }, error: null }) }),
          };
        },
      };
    },
  };
  return { client: client as unknown as CreatePurchaseDraftParams['supabase'], inserts, updates };
}

// Exercise the actual import path through persisted purchase/line payloads.
// Existing suppliers deliberately contain stale metadata from an older import.
for (const fixture of fixtures) {
  for (const existingSupplier of [false, true]) {
    Deno.test(`purchase draft imports ${fixture.name} with ${existingSupplier ? 'an existing' : 'a new'} supplier`, async () => {
      const parsedInvoice = parseInvoiceText(fixture.rawText);
      const { expected, expectedPurchase } = fixture;
      const { client, inserts, updates } = mockSupabase();
      const suppliers = existingSupplier ? [{
        id: 'existing-supplier', name: expected.supplierName, vat_number: expected.vatNumber,
        country: 'US', supplier_type: 'non_eu',
      }] as CreatePurchaseDraftParams['suppliers'] : [];
      const values = buildPurchaseDraftDefaults({ parsedInvoice, extractedText: fixture.rawText, suppliers });
      const rate = expected.currency === 'SEK' ? 1 : 10;
      const result = await createPurchaseDraft({
        supabase: client, suppliers, parsedInvoice, extractedText: fixture.rawText, values,
        duplicateInvoiceMessage: 'Duplicate invoice', fullAmountLabel: 'Purchase',
        exchangeRateLookup: { currency: expected.currency, rate, rateDate: expected.invoiceDate || '2026-10-01', source: 'ECB' },
      });
      const purchase = inserts.acc_purchases[0];
      const line = inserts.acc_purchase_lines[0];
      const round = (value: number) => Math.round(value * rate * 100) / 100;

      assertEqual(line.vat_treatment, expectedPurchase.vatTreatment, 'persisted VAT treatment');
      assertEqual(line.expense_account, expectedPurchase.expenseAccount, 'expense account');
      assertEqual(result.documentQualityStatus, expectedPurchase.documentQualityStatus, 'document quality');
      assertEqual(purchase.supplier_invoice_number, expected.invoiceNumber, 'invoice number');
      assertEqual(purchase.original_currency, expected.currency, 'original currency');
      assertEqual(purchase.original_gross_amount, expected.grossAmount ?? 0, 'original gross amount');
      assertEqual(purchase.original_vat_amount, expected.vatAmount ?? 0, 'original VAT amount');
      assertEqual(line.gross_amount, round(expected.grossAmount ?? 0), 'converted gross amount');
      assertEqual(line.vat_amount, round(expected.vatAmount ?? 0), 'converted VAT amount');
      if (expected.invoiceDate) assertEqual(purchase.document_date, expected.invoiceDate, 'invoice date');
      if (parsedInvoice.description) assertEqual(purchase.description, parsedInvoice.description, 'product description');

      const journal = buildJournalPreview([{
        expense_account: line.expense_account as string,
        vat_treatment: line.vat_treatment as VatTreatment,
        net_amount: line.net_amount as number,
        vat_amount: line.vat_amount as number,
        gross_amount: line.gross_amount as number,
        description: values.description,
      }], 'owner_paid', values.description);
      assertEqual(journal.find((entry) => entry.account === '2641')?.debit ?? 0,
        expectedPurchase.vatTreatment === 'domestic_deductible' ? round(expected.vatAmount ?? 0) : 0,
        'deductible input VAT journal amount');
      assertEqual(journal.find((entry) => entry.account === '2645')?.debit ?? 0,
        expectedPurchase.vatTreatment.startsWith('reverse_charge')
          ? Math.round(Number(line.net_amount) * 25) / 100 : 0,
        'reverse-charge input VAT journal amount');

      if (!existingSupplier) {
        assertEqual(inserts.acc_suppliers[0].vat_number, expected.vatNumber?.replace(/\s+/g, '') ?? null, 'supplier VAT, not buyer VAT');
        assertEqual(inserts.acc_suppliers[0].country, expected.supplierCountry, 'supplier country');
      }
      if (existingSupplier && expected.fingerprintId === 'coolshop_receipt') {
        assertEqual(updates[0].id, 'existing-supplier', 'correct supplier updated');
        assertEqual(updates[0].payload.country, 'SE', 'persisted country correction');
        assertEqual(updates[0].payload.supplier_type, 'domestic', 'persisted supplier type correction');
        assertEqual(result.suppliers[0].country, 'SE', 'returned supplier country');
        assertEqual(result.suppliers[0].vat_number, expected.vatNumber, 'original VAT registration preserved');
      } else {
        assertEqual(updates.length, 0, 'unrelated suppliers are not updated');
      }
    });
  }
}

for (const scenario of ['update_failure', 'different_vat_registration', 'already_correct'] as const) {
  Deno.test(`Coolshop supplier correction handles ${scenario}`, async () => {
    const fixture = fixtures.find(({ expected }) => expected.fingerprintId === 'coolshop_receipt')!;
    const parsedInvoice = parseInvoiceText(fixture.rawText);
    const { client, inserts, updates } = mockSupabase(scenario === 'update_failure'
      ? { message: 'Supplier update denied', code: '42501' } : null);
    const suppliers = [{
      id: 'coolshop-supplier', name: fixture.expected.supplierName,
      vat_number: scenario === 'different_vat_registration' ? 'DK12345678' : fixture.expected.vatNumber,
      country: scenario === 'already_correct' ? 'SE' : 'DK',
      supplier_type: scenario === 'already_correct' ? 'domestic' : 'eu',
    }] as CreatePurchaseDraftParams['suppliers'];
    const values = buildPurchaseDraftDefaults({ parsedInvoice, extractedText: fixture.rawText, suppliers });
    try {
      await createPurchaseDraft({
        supabase: client, suppliers, parsedInvoice, extractedText: fixture.rawText, values,
        duplicateInvoiceMessage: 'Duplicate invoice', fullAmountLabel: 'Purchase',
      });
    } catch (error) {
      if (scenario !== 'update_failure' || !(error instanceof PurchaseDraftError)) throw error;
      assertEqual(error.stage, 'supplier_update', 'reported failure stage');
      assertEqual(error.code, '42501', 'database error preserved');
      assertEqual(inserts.acc_purchases?.length ?? 0, 0, 'failed correction does not create a draft');
      return;
    }
    if (scenario === 'update_failure') throw new Error('Expected supplier update failure');
    assertEqual(updates.length, 0, 'supplier update is unnecessary or identity does not match');
    assertEqual(inserts.acc_purchase_lines[0].vat_treatment, 'domestic_deductible', 'receipt determines VAT independently');
  });
}
