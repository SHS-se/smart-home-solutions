/// <reference lib="deno.ns" />

import {
  inferSupplierMetadata,
  inferVatTreatment,
  extractInvoiceNumberFromNotes,
  resolveSavedPurchaseId,
} from './purchase-workflow.ts';
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

const AMAZON_INVOICE: ParsedInvoice = {
  supplierName: 'Amazon EU S.à r.l., Sverige Filial',
  invoiceNumber: 'SE6EK5YAEUI',
  invoiceDate: '2026-03-13',
  dueDate: null,
  grossAmount: 472.58,
  netAmount: 378.06,
  vatAmount: 94.52,
  vatRate: 25,
  currency: 'SEK',
  orgNumber: null,
  vatNumber: 'SE516412220101',
  description: 'Shelly Dimmer 2 (Amazon inköp)',
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

Deno.test('inferVatTreatment classifies Swedish VAT invoices as domestic deductible', () => {
  const vatTreatment = inferVatTreatment({
    parsedInvoice: AMAZON_INVOICE,
    extractedText: 'Moms # SE516412220101',
  });

  assertEqual(vatTreatment, 'domestic_deductible', 'vatTreatment');
});

Deno.test('resolveSavedPurchaseId prefers newly created purchase id when creating a draft', () => {
  const purchaseId = resolveSavedPurchaseId(null, 'new-purchase-id');
  assertEqual(purchaseId, 'new-purchase-id', 'purchaseId');
});
