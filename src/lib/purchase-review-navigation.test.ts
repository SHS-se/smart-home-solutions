/// <reference lib="deno.ns" />

import {
  createBatchPurchaseReviewState,
  getPurchaseReviewAfterDelete,
  readBatchPurchaseReviewIds,
} from './purchase-review-navigation.ts';

function assertEqual<T>(actual: T, expected: T, label: string): void {
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    throw new Error(`${label}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
  }
}

function assertThrows(fn: () => void, expectedMessage: string, label: string): void {
  try {
    fn();
  } catch (error) {
    if (error instanceof Error && error.message === expectedMessage) return;
    throw new Error(`${label}: unexpected error ${String(error)}`);
  }

  throw new Error(`${label}: expected an error`);
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

Deno.test('deleting a reviewed purchase continues with the following purchase', () => {
  assertEqual(
    getPurchaseReviewAfterDelete(['first-id', 'second-id', 'third-id'], 'second-id'),
    {
      destinationPurchaseId: 'third-id',
      remainingPurchaseIds: ['first-id', 'third-id'],
    },
    'review after deleting middle purchase',
  );
});

Deno.test('deleting the first reviewed purchase continues with the second purchase', () => {
  assertEqual(
    getPurchaseReviewAfterDelete(['first-id', 'second-id', 'third-id'], 'first-id'),
    {
      destinationPurchaseId: 'second-id',
      remainingPurchaseIds: ['second-id', 'third-id'],
    },
    'review after deleting first purchase',
  );
});

Deno.test('deleting the last reviewed purchase continues with the preceding purchase', () => {
  assertEqual(
    getPurchaseReviewAfterDelete(['first-id', 'second-id'], 'second-id'),
    {
      destinationPurchaseId: 'first-id',
      remainingPurchaseIds: ['first-id'],
    },
    'review after deleting last purchase',
  );
});

Deno.test('deleting the only reviewed purchase leaves no review destination', () => {
  assertEqual(
    getPurchaseReviewAfterDelete(['only-id'], 'only-id'),
    {
      destinationPurchaseId: null,
      remainingPurchaseIds: [],
    },
    'review after deleting only purchase',
  );
});

Deno.test('deleting a purchase outside the active sequence fails fast', () => {
  assertThrows(
    () => getPurchaseReviewAfterDelete(['first-id', 'second-id'], 'missing-id'),
    'Deleted purchase is not in the active review sequence',
    'missing deleted purchase',
  );
});
