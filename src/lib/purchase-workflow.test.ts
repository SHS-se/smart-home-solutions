/// <reference lib="deno.ns" />

import { inferSupplierMetadata, inferVatTreatment, extractInvoiceNumberFromNotes } from './purchase-workflow.ts';
import type { ParsedInvoice } from './invoice-parser.ts';

function assertEqual<T>(actual: T, expected: T, label: string): void {
  if (actual !== expected) {
    throw new Error(`${label}: expected ${String(expected)}, got ${String(actual)}`);
  }
}

const STRIPE_INVOICE: ParsedInvoice = {
  supplierName: 'Stripe Payments Europe, Limited',
  invoiceNumber: 'T41QIV6Y-2026-03-01',
  invoiceDate: '2026-04-05',
  dueDate: null,
  grossAmount: 290.03,
  netAmount: 290.03,
  vatAmount: 0,
  vatRate: 0,
  currency: 'SEK',
  orgNumber: null,
  vatNumber: 'IE 3206488LH',
  description: 'Stripe avgifter mars 2026',
  confidence: {},
};

Deno.test('inferSupplierMetadata classifies VAT-numbered EU suppliers correctly', () => {
  const inferred = inferSupplierMetadata(STRIPE_INVOICE);

  assertEqual(inferred.country, 'IE', 'country');
  assertEqual(inferred.supplierType, 'eu', 'supplierType');
  assertEqual(inferred.vatNumber, 'IE3206488LH', 'vatNumber');
});

Deno.test('inferVatTreatment defaults EU zero-VAT invoices to reverse charge', () => {
  const vatTreatment = inferVatTreatment({
    parsedInvoice: STRIPE_INVOICE,
    extractedText: 'Reverse Charge VAT may be applicable.',
  });

  assertEqual(vatTreatment, 'reverse_charge', 'vatTreatment');
});

Deno.test('inferVatTreatment keeps foreign VAT out of deductible domestic treatment', () => {
  const vatTreatment = inferVatTreatment({
    parsedInvoice: {
      ...STRIPE_INVOICE,
      vatAmount: 12.5,
      vatRate: 5,
    },
    extractedText: 'Foreign receipt with VAT charged abroad.',
  });

  assertEqual(vatTreatment, 'non_deductible', 'vatTreatment');
});

Deno.test('extractInvoiceNumberFromNotes supports legacy Swedish note prefix', () => {
  const invoiceNumber = extractInvoiceNumberFromNotes('Leverantörens fakturanr: EU4860167');
  assertEqual(invoiceNumber, 'EU4860167', 'invoiceNumber');
});
