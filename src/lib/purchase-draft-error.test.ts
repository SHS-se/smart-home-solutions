/// <reference lib="deno.ns" />

import {
  describePurchaseDraftError,
  PurchaseDraftError,
  toPurchaseDraftError,
} from './purchase-draft-error.ts';

function assertEqual<T>(actual: T, expected: T, label: string): void {
  if (actual !== expected) {
    throw new Error(`${label}: expected ${String(expected)}, got ${String(actual)}`);
  }
}

Deno.test('toPurchaseDraftError captures backend details, hint, code, and status', () => {
  const error = toPurchaseDraftError(
    {
      message: 'Insert failed',
      details: 'Null value in column "document_date"',
      hint: 'Check the parsed invoice date',
      code: '23502',
      status: 400,
    },
    {
      stage: 'purchase_insert',
      fallbackMessage: 'Could not save purchase draft',
      extraDetails: ['Currency: USD'],
    },
  );

  assertEqual(error.message, 'Insert failed', 'message');
  assertEqual(error.stage, 'purchase_insert', 'stage');
  assertEqual(error.code, '23502', 'code');
  assertEqual(error.status, 400, 'status');
  assertEqual(error.details.includes('Null value in column "document_date"'), true, 'details');
  assertEqual(error.details.includes('Hint: Check the parsed invoice date'), true, 'hint');
  assertEqual(error.details.includes('Currency: USD'), true, 'extraDetail');
});

Deno.test('describePurchaseDraftError preserves structured purchase draft errors', () => {
  const described = describePurchaseDraftError(
    new PurchaseDraftError({
      message: 'Duplicate supplier invoice',
      stage: 'duplicate_check',
      details: ['Supplier invoice number: 56FB0333-0001'],
      code: '23505',
    }),
    'Could not create draft',
  );

  assertEqual(described.message, 'Duplicate supplier invoice', 'message');
  assertEqual(described.stage, 'duplicate_check', 'stage');
  assertEqual(described.code, '23505', 'code');
  assertEqual(described.details[0], 'Supplier invoice number: 56FB0333-0001', 'detail');
});
