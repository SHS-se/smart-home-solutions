/// <reference lib="deno.ns" />

import {
  buildPurchaseImportRateKey,
  buildPurchaseImportRateLookupMap,
  collectUniquePurchaseImportRateRequests,
} from './purchase-import-exchange-rates.ts';

function assertEqual<T>(actual: T, expected: T, label: string): void {
  if (actual !== expected) {
    throw new Error(`${label}: expected ${String(expected)}, got ${String(actual)}`);
  }
}

Deno.test('collectUniquePurchaseImportRateRequests deduplicates foreign-currency lookups per batch', () => {
  const requests = collectUniquePurchaseImportRateRequests([
    { currency: 'usd', documentDate: '2026-03-28' },
    { currency: 'USD', documentDate: '2026-03-28' },
    { currency: 'EUR', documentDate: '2026-03-26' },
    { currency: 'SEK', documentDate: '2026-03-26' },
  ]);

  assertEqual(requests.length, 2, 'requestCount');
  assertEqual(requests[0].currency, 'USD', 'firstCurrency');
  assertEqual(requests[0].documentDate, '2026-03-28', 'firstDate');
  assertEqual(requests[1].currency, 'EUR', 'secondCurrency');
  assertEqual(requests[1].documentDate, '2026-03-26', 'secondDate');
});

Deno.test('buildPurchaseImportRateLookupMap keys ECB results by requested currency and document date', () => {
  const lookupMap = buildPurchaseImportRateLookupMap(
    [
      { currency: 'USD', documentDate: '2026-03-28' },
    ],
    [
      { currency: 'USD', rate: 10.58491499, rateDate: '2026-03-27', source: 'ECB' },
    ],
  );

  const result = lookupMap.get(buildPurchaseImportRateKey('USD', '2026-03-28'));
  if (!result) {
    throw new Error('Expected lookup result for USD 2026-03-28');
  }

  assertEqual(result.rateDate, '2026-03-27', 'rateDate');
  assertEqual(result.rate, 10.58491499, 'rate');
});
