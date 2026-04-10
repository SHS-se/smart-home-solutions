/// <reference lib="deno.ns" />

import {
  findExistingSupplier,
  findDuplicatePurchaseId,
  inferSupplierMetadata,
  inferVatTreatment,
  extractInvoiceNumberFromNotes,
  normalizeSupplierName,
  normalizeSupplierInvoiceNumber,
  normalizeVatNumber,
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
  supplierCountry: 'IE',
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
  fingerprint: { id: 'stripe_tax_invoice', label: 'Stripe tax invoice', recognized: true },
  parserReviewRequired: false,
  parserReviewReasons: [],
};

const AMAZON_INVOICE: ParsedInvoice = {
  supplierName: 'Amazon EU S.à r.l., Sverige Filial',
  supplierCountry: 'SE',
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
  fingerprint: { id: 'amazon_sweden_invoice', label: 'Amazon Sweden invoice', recognized: true },
  parserReviewRequired: false,
  parserReviewReasons: [],
};

const ANTHROPIC_INVOICE: ParsedInvoice = {
  supplierName: 'Anthropic, PBC',
  supplierCountry: 'US',
  invoiceNumber: 'DSUQQKNL-0001',
  invoiceDate: '2026-03-26',
  dueDate: null,
  grossAmount: 12.5,
  netAmount: 10,
  vatAmount: 2.5,
  vatRate: 25,
  currency: 'USD',
  orgNumber: null,
  vatNumber: null,
  description: 'One-time credit purchase',
  confidence: {},
  fingerprint: { id: 'anthropic_invoice', label: 'Anthropic invoice', recognized: true },
  parserReviewRequired: false,
  parserReviewReasons: [],
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

Deno.test('inferVatTreatment treats Anthropic invoices with Swedish VAT as domestic deductible', () => {
  const vatTreatment = inferVatTreatment({
    parsedInvoice: ANTHROPIC_INVOICE,
    extractedText: 'VAT - Sweden (25% on $10.00) $2.50',
  });

  assertEqual(vatTreatment, 'domestic_deductible', 'vatTreatment');
});

Deno.test('inferSupplierMetadata prefers parsed supplier country over marketplace VAT prefixes', () => {
  const inferred = inferSupplierMetadata({
    supplierName: 'ShenZhenShiYiDuoJinDianZiShangWuYouXianGongSi',
    supplierCountry: 'CN',
    invoiceNumber: 'SE6IPMBAEUD',
    invoiceDate: '2026-02-03',
    dueDate: null,
    grossAmount: 112.98,
    netAmount: 90.38,
    vatAmount: 22.6,
    vatRate: 25,
    currency: 'SEK',
    orgNumber: null,
    vatNumber: null,
    description: 'Ewwtrey 260 stycken M3-nylon sexkantskruvar',
    confidence: {},
    fingerprint: { id: 'amazon_marketplace_invoice', label: 'Amazon marketplace invoice', recognized: true },
    parserReviewRequired: false,
    parserReviewReasons: [],
  });

  assertEqual(inferred.country, 'CN', 'country');
  assertEqual(inferred.supplierType, 'non_eu', 'supplierType');
  assertEqual(inferred.vatNumber, null, 'vatNumber');
});

Deno.test('resolveSavedPurchaseId prefers newly created purchase id when creating a draft', () => {
  const purchaseId = resolveSavedPurchaseId(null, 'new-purchase-id');
  assertEqual(purchaseId, 'new-purchase-id', 'purchaseId');
});

Deno.test('normalizeSupplierInvoiceNumber trims and uppercases supplier invoice numbers', () => {
  const invoiceNumber = normalizeSupplierInvoiceNumber(' se6ek5yaeui ');
  assertEqual(invoiceNumber, 'SE6EK5YAEUI', 'invoiceNumber');
});

Deno.test('normalizeSupplierInvoiceNumber removes separators so split invoice numbers still compare correctly', () => {
  const invoiceNumber = normalizeSupplierInvoiceNumber('56FB0333-0001');
  assertEqual(invoiceNumber, '56FB03330001', 'invoiceNumber');
});

Deno.test('findDuplicatePurchaseId matches by supplier and normalized supplier invoice number', () => {
  const duplicatePurchaseId = findDuplicatePurchaseId(
    [
      { id: 'existing-1', supplier_id: 'supplier-1', supplier_invoice_number: 'SE6EK5YAEUI' },
      { id: 'existing-2', supplier_id: 'supplier-2', supplier_invoice_number: 'SE6EK5YAEUI' },
    ],
    'supplier-1',
    ' se6ek5yaeui ',
  );

  assertEqual(duplicatePurchaseId, 'existing-1', 'duplicatePurchaseId');
});

Deno.test('findDuplicatePurchaseId does not treat OpenAI 0001 and 0002 invoices as duplicates', () => {
  const duplicatePurchaseId = findDuplicatePurchaseId(
    [
      { id: 'existing-openai-1', supplier_id: 'supplier-openai', supplier_invoice_number: '56FB0333-0001' },
    ],
    'supplier-openai',
    '56FB0333-0002',
  );

  assertEqual(duplicatePurchaseId, null, 'duplicatePurchaseId');
});

Deno.test('findExistingSupplier prefers VAT-number match before creating a new supplier', () => {
  const supplier = findExistingSupplier(
    [
      { id: 'amazon-existing', name: 'Amazon EU S.à r.l., Sverige Filial', vat_number: 'SE516412220101' },
      { id: 'openai-existing', name: 'OpenAI OpCo, LLC', vat_number: null },
    ],
    {
      supplierName: 'Amazon EU S.a r.l., Sverige Filial',
      vatNumber: 'SE 516412220101',
    },
  );

  assertEqual(supplier?.id || null, 'amazon-existing', 'supplierId');
});

Deno.test('findExistingSupplier matches normalized supplier names when VAT number is missing', () => {
  const supplier = findExistingSupplier(
    [
      { id: 'openai-existing', name: 'OpenAI OpCo, LLC', vat_number: null },
    ],
    {
      supplierName: 'OpenAI OpCo LLC',
      vatNumber: null,
    },
  );

  assertEqual(supplier?.id || null, 'openai-existing', 'supplierId');
});

Deno.test('normalizeSupplierName removes punctuation and accents for supplier matching', () => {
  const supplierName = normalizeSupplierName('Amazon EU S.à r.l., Sverige Filial');
  assertEqual(supplierName, 'AMAZONEUSARLSVERIGEFILIAL', 'supplierName');
});

Deno.test('normalizeVatNumber removes spaces and uppercases VAT numbers', () => {
  const vatNumber = normalizeVatNumber(' se 516412220101 ');
  assertEqual(vatNumber, 'SE516412220101', 'vatNumber');
});
