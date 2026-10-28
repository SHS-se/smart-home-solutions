import { assertEquals } from '@std/assert';
import { billedMonths } from './billed-months';
import type { EnergyBillingDocumentForSeries as Bill } from '../energy-billing-series';
const bill = (id: string, documentKind: Bill['documentKind'], periodCostSek: number, periodStart = '2026-06-01', periodEnd = '2026-06-30'): Bill =>
  ({ id, documentKind, periodCostSek, periodStart, periodEnd, consumptionKwh: 100, exportedKwh: null, peakDemandKw: null, lineItems: [] });
Deno.test('Actual sums original electricity and grid bills including a mid-month supplier change', () => {
  const docs = [bill('old', 'electricity', -82.5, '2026-06-01', '2026-06-15'), bill('new', 'electricity', -85, '2026-06-16'), bill('grid', 'grid', 1144)];
  const m = billedMonths(docs, 1).get('2026-06')!;
  assertEquals(m.totalSek, 976.5); assertEquals(m.reason, null); assertEquals(m.documentIds, ['old', 'new', 'grid']);
});
Deno.test('missing, partial, overlapping and unassigned multi-home bills cannot produce Actual', () => {
  const docs = [bill('electricity', 'electricity', 200), bill('grid', 'grid', 100)];
  assertEquals(billedMonths(docs.slice(0, 1), 1).get('2026-06')!.totalSek, null);
  assertEquals(billedMonths([bill('e', 'electricity', 20, '2026-06-16'), docs[1]], 1).get('2026-06')!.reason, 'partial');
  assertEquals(billedMonths([...docs, bill('duplicate', 'electricity', 200)], 1).get('2026-06')!.reason, 'overlap');
  assertEquals(billedMonths(docs, 2).get('2026-06')!.reason, 'multiple_homes');
  assertEquals(billedMonths(docs, 1).get('2026-07'), undefined);
});
