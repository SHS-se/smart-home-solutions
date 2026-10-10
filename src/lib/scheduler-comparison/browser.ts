import type { BenchCase } from '../planner-bench/case';
import type { CriteriaOverrides } from '../planner-bench/types';
import type { DefaultSettings, SchedulerComparison } from './comparison';

export interface ComparisonRequest { scenario: BenchCase; settings: DefaultSettings; criteria: CriteriaOverrides }
export interface ComparisonResponse { result: SchedulerComparison; engineHash: string }

/** Private worker per request: cancellation discards all mutable solver/controller state. */
export function runComparison(request: ComparisonRequest, signal: AbortSignal): Promise<ComparisonResponse> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) { reject(new DOMException('Cancelled', 'AbortError')); return; }
    const worker = new Worker(new URL('./worker.ts', import.meta.url), { type: 'module' });
    const cleanup = () => { worker.terminate(); signal.removeEventListener('abort', cancel); };
    const cancel = () => { cleanup(); reject(new DOMException('Cancelled', 'AbortError')); };
    signal.addEventListener('abort', cancel, { once: true });
    worker.onmessage = (event: MessageEvent<ComparisonResponse & { error?: string }>) => {
      cleanup();
      if (event.data.error) reject(new Error(event.data.error)); else resolve(event.data);
    };
    worker.onerror = event => { cleanup(); reject(new Error(event.message || 'Comparison worker failed')); };
    worker.postMessage(request);
  });
}
