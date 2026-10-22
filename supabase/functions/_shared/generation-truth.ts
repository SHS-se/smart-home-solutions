/** Resolve revised actuals by whole requested hour, retaining the truth observation identity. */
import type { EntsoeInterval } from './entsoe-market-data.ts';
const HOUR = 3_600_000;
export interface GenerationTruthDocument {
  id: string; sequence: number; requestedFrom: string; requestedTo: string;
  intervals: readonly EntsoeInterval[];
}
export function resolveGenerationTruth(documents: readonly GenerationTruthDocument[]) {
  const hours = new Map<number, { observationId: string; intervals: EntsoeInterval[] }>();
  for (const document of [...documents].sort((a, b) => a.sequence - b.sequence)) {
    const from = Date.parse(document.requestedFrom), to = Date.parse(document.requestedTo);
    if (!Number.isFinite(from) || !Number.isFinite(to) || to <= from) throw new Error('Invalid actual-generation request interval');
    const start = Math.ceil(from / HOUR) * HOUR, end = Math.floor(to / HOUR) * HOUR;
    const replacement = new Map<number, EntsoeInterval[]>();
    for (let at = start; at < end; at += HOUR) replacement.set(at, []);
    for (const interval of document.intervals) {
      for (let at = Math.floor(interval.startMs / HOUR) * HOUR; at < interval.endMs; at += HOUR) {
        const held = replacement.get(at);
        if (held) held.push({ ...interval, startMs: Math.max(at, interval.startMs), endMs: Math.min(at + HOUR, interval.endMs) });
      }
    }
    // An empty newer hour explicitly removes older truth, including edge omissions.
    for (const [at, intervals] of replacement) hours.set(at, { observationId: document.id, intervals });
  }
  return { intervals: [...hours.values()].flatMap(row => row.intervals),
    hourSources: Object.fromEntries([...hours].map(([at, row]) => [new Date(at).toISOString(), row.observationId])) };
}
