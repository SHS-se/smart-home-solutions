import { assertEquals, assertThrows } from '@std/assert';
import { resolveGenerationTruth, type GenerationTruthDocument } from '../supabase/functions/_shared/generation-truth.ts';
import type { EntsoeInterval } from '../supabase/functions/_shared/entsoe-market-data.ts';
const iso = (hour: number) => new Date(Date.UTC(2026, 9, 22, hour)).toISOString();
function interval(hour: number, value: number): EntsoeInterval {
  return { startMs: Date.parse(iso(hour)), endMs: Date.parse(iso(hour + 1)), value, psrType: 'B14',
    flow: 'production', unit: 'MAW', resolution: 'PT60M', businessType: 'A01', seriesId: 'nuclear' };
}
function doc(id: string, sequence: number, intervals: EntsoeInterval[], from = 12, to = 15): GenerationTruthDocument {
  return { id, sequence, intervals, requestedFrom: iso(from), requestedTo: iso(to) };
}
Deno.test('new actual revision removes omitted edge/interior hours instead of filling from older documents', () => {
  const old = doc('old', 1, [interval(12, 100), interval(13, 200), interval(14, 300)]);
  const newest = doc('new', 2, [interval(13, 250)]);
  const result = resolveGenerationTruth([newest, old]); // Input ordering is not acquisition ordering.
  assertEquals(result.intervals, [interval(13, 250)]);
  assertEquals(result.hourSources, { [iso(12)]: 'new', [iso(13)]: 'new', [iso(14)]: 'new' });
  assertEquals(resolveGenerationTruth([old, doc('empty', 3, [])]).intervals, []);
});
Deno.test('partial requested edge hours cannot replace earlier complete truth outside the new scope', () => {
  const old = doc('old', 1, [interval(12, 100), interval(13, 200), interval(14, 300)]);
  const newDocument = doc('new', 2, [interval(12, 999), interval(13, 250), interval(14, 999)]);
  newDocument.requestedFrom = '2026-10-22T12:30:00Z';
  newDocument.requestedTo = '2026-10-22T14:30:00Z';
  const result = resolveGenerationTruth([old, newDocument]);
  assertEquals(result.intervals.map(row => row.value).sort((a, b) => a - b), [100, 250, 300]);
  assertEquals(result.hourSources, { [iso(12)]: 'old', [iso(13)]: 'new', [iso(14)]: 'old' });
  assertThrows(() => resolveGenerationTruth([{ ...old, requestedFrom: 'bad' }]));
});
