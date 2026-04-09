/// <reference lib="deno.ns" />

import {
  buildExchangeSnapshot,
  buildPurchaseVatSummary,
  detectForeignCurrencyIntegrityIssue,
} from './accounting-fx.ts';

function assertEqual<T>(actual: T, expected: T, label: string): void {
  if (actual !== expected) {
    throw new Error(`${label}: expected ${String(expected)}, got ${String(actual)}`);
  }
}

Deno.test('buildExchangeSnapshot converts a USD purchase into persisted SEK values', () => {
  const snapshot = buildExchangeSnapshot({
    documentDate: '2026-03-28',
    currency: 'USD',
    originalAmounts: {
      gross: 5.05,
      net: 5.05,
      vat: 0,
    },
    lookup: {
      currency: 'USD',
      rate: 10.87,
      rateDate: '2026-03-27',
      source: 'ECB',
    },
  });

  assertEqual(snapshot.originalCurrency, 'USD', 'originalCurrency');
  assertEqual(snapshot.convertedNetSek, 54.89, 'convertedNetSek');
  assertEqual(snapshot.exchangeRateDate, '2026-03-27', 'exchangeRateDate');
  assertEqual(snapshot.exchangeRateSource, 'ECB', 'exchangeRateSource');
});

Deno.test('buildPurchaseVatSummary calculates reverse-charge VAT in SEK only', () => {
  const snapshot = buildExchangeSnapshot({
    documentDate: '2026-03-28',
    currency: 'USD',
    originalAmounts: {
      gross: 5.05,
      net: 5.05,
      vat: 0,
    },
    lookup: {
      currency: 'USD',
      rate: 10.87,
      rateDate: '2026-03-27',
      source: 'ECB',
    },
  });

  const summary = buildPurchaseVatSummary([
    {
      expense_account: '4000',
      vat_treatment: 'reverse_charge',
      net_amount: snapshot.convertedNetSek,
      vat_amount: snapshot.convertedVatSek,
      gross_amount: snapshot.convertedGrossSek,
      description: 'OpenAI usage credit',
    },
  ], snapshot);

  assertEqual(summary.reverseChargeBaseSek, 54.89, 'reverseChargeBaseSek');
  assertEqual(summary.reverseChargeOutputVatSek, 13.72, 'reverseChargeOutputVatSek');
  assertEqual(summary.reverseChargeInputVatSek, 13.72, 'reverseChargeInputVatSek');
  assertEqual(summary.paymentAccountAmountSek, 54.89, 'paymentAccountAmountSek');
});

Deno.test('detectForeignCurrencyIntegrityIssue flags legacy foreign amounts stored as SEK', () => {
  const expected = buildExchangeSnapshot({
    documentDate: '2026-03-28',
    currency: 'USD',
    originalAmounts: {
      gross: 5.05,
      net: 5.05,
      vat: 0,
    },
    lookup: {
      currency: 'USD',
      rate: 10.87,
      rateDate: '2026-03-27',
      source: 'ECB',
    },
  });

  const issue = detectForeignCurrencyIntegrityIssue({
    currency: 'USD',
    original_currency: 'USD',
    original_gross_amount: 5.05,
    original_net_amount: 5.05,
    original_vat_amount: 0,
    gross_amount: 5.05,
    net_amount: 5.05,
    vat_amount: 0,
    converted_gross_amount_sek: 5.05,
    converted_net_amount_sek: 5.05,
    converted_vat_amount_sek: 0,
    exchange_rate_source: 'LEGACY_UNCONVERTED',
    document_date: '2026-03-28',
    status: 'posted',
  }, expected);

  if (!issue) {
    throw new Error('Expected integrity issue to be detected');
  }

  assertEqual(issue.status, 'posted_requires_correction', 'status');
});
