/// <reference lib="deno.ns" />

import { resolveEcbExchangeRate } from './ecb-rate-core.ts';

function assertEqual<T>(actual: T, expected: T, label: string): void {
  if (actual !== expected) {
    throw new Error(`${label}: expected ${String(expected)}, got ${String(actual)}`);
  }
}

Deno.test('resolveEcbExchangeRate uses the latest available ECB business-day rate for weekend USD invoices', () => {
  const result = resolveEcbExchangeRate(
    {
      currency: 'USD',
      documentDate: '2026-03-28',
    },
    [
      {
        date: '2026-03-27',
        sekPerEur: 10.768034019803293,
        usdPerEur: 1.0172999999999999,
      },
      {
        date: '2026-03-26',
        sekPerEur: 10.734866747263068,
        usdPerEur: 1.0789000000000000,
      },
    ],
  );

  assertEqual(result.currency, 'USD', 'currency');
  assertEqual(result.rateDate, '2026-03-27', 'rateDate');
  assertEqual(result.source, 'ECB', 'source');
  assertEqual(result.rate, 10.58491499, 'rate');
});
