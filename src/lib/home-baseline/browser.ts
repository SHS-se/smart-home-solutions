import { loadHomeBaseline, type HomeRef } from './history';
import type { BaselineAnchor, BaselinePeriod } from './period';
import type { SchedulerReplay } from './scheduler-replay';
import type { ModelComparison } from './model-comparison';
import type { BaselineInput, BaselineResult } from './model';
import { withPoolState, type PoolStart } from './pool-carry';

export interface BaselineResponse { result: BaselineResult; engineHash: string }
export interface BaselineCapture extends BaselineResponse { input: BaselineInput }

export interface ComparisonCapture extends BaselineCapture { scheduler: SchedulerReplay; modeled: ModelComparison }
export async function generateHomeBaseline(ref: HomeRef, anchor: BaselineAnchor, period: BaselinePeriod, signal: AbortSignal, pool: PoolStart | null): Promise<ComparisonCapture> {
  const input = await loadHomeBaseline(ref, anchor, period, signal);
  input.pool = pool;
  input.problem = withPoolState(input.problem, pool?.initial.baseline);
  const projected = await new Promise<Omit<ComparisonCapture, 'input'>>((resolve, reject) => {
    if (signal.aborted) { reject(new DOMException('Cancelled', 'AbortError')); return; }
    const worker = new Worker(new URL('./worker.ts', import.meta.url), { type: 'module' });
    const cleanup = () => { worker.terminate(); signal.removeEventListener('abort', cancel); };
    const cancel = () => { cleanup(); reject(new DOMException('Cancelled', 'AbortError')); };
    signal.addEventListener('abort', cancel, { once: true });
    worker.onmessage = (event: MessageEvent<Omit<ComparisonCapture, 'input'> & { error?: string }>) => {
      cleanup();
      if (event.data.error) reject(new Error(event.data.error)); else resolve(event.data);
    };
    worker.onerror = event => { cleanup(); reject(new Error(event.message || 'Default model worker failed')); };
    worker.postMessage(input);
  });
  return { input, ...projected };
}
