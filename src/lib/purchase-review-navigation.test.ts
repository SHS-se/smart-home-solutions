/// <reference lib="deno.ns" />

import {
  createBatchPurchaseReviewState,
  readBatchPurchaseReviewIds,
} from './purchase-review-navigation.ts';

function assertEqual<T>(actual: T, expected: T, label: string): void {
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    throw new Error(`${label}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
  }
}

Deno.test('batch purchase review state preserves successful upload order', () => {
  const state = createBatchPurchaseReviewState(['first-id', 'second-id', 'third-id']);

  assertEqual(
    readBatchPurchaseReviewIds(state, 'first-id'),
    ['first-id', 'second-id', 'third-id'],
    'purchaseIds',
  );
});

Deno.test('batch purchase review state is ignored outside its imported batch', () => {
  const state = createBatchPurchaseReviewState(['first-id', 'second-id']);

  assertEqual(readBatchPurchaseReviewIds(state, 'unrelated-id'), null, 'purchaseIds');
});

Deno.test('batch purchase review state rejects malformed and duplicate ids', () => {
  assertEqual(createBatchPurchaseReviewState([]), null, 'empty batch');
  assertEqual(createBatchPurchaseReviewState(['same-id', 'same-id']), null, 'duplicate ids');
  assertEqual(
    readBatchPurchaseReviewIds({
      purchaseReview: {
        source: 'upload_batch',
        purchaseIds: ['valid-id', 42],
      },
    }, 'valid-id'),
    null,
    'malformed ids',
  );
});
