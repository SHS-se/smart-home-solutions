import { loadHomeBaseline, type HomeRef } from './history';
import type { BaselineAnchor, BaselinePeriod } from './period';
import type { SchedulerReplay } from './scheduler-replay';
import type { ModelComparison } from './model-comparison';
import type { BaselineInput, BaselineResult } from './model';
import type { SimulationBasis } from './simulation-state';
import { withSimulationBasis } from './simulation-state';

export interface BaselineResponse { result: BaselineResult; engineHash: string }
export interface BaselineCapture extends BaselineResponse { input: BaselineInput }

export interface ComparisonCapture extends BaselineCapture { scheduler: SchedulerReplay; modeled: ModelComparison }
export async function generateHomeBaseline(ref: HomeRef, anchor: BaselineAnchor, period: BaselinePeriod, signal: AbortSignal, basis: SimulationBasis | null): Promise<ComparisonCapture> {
  return projectHomeBaseline(await loadHomeBaseline(ref, anchor, period, signal), signal, basis);
}

/** Shared worker boundary for the pinned home and equipment trials. */
export async function projectHomeBaseline(prepared: BaselineInput, signal: AbortSignal, basis: SimulationBasis | null): Promise<ComparisonCapture> {
  const input = withSimulationBasis(prepared, basis);
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
    worker.onerror = event => {
      cleanup();
      reject(new Error(event.message || 'ROI calculation worker could not start or stopped unexpectedly. Reload the page to load the current version.'));
    };
    worker.postMessage(input);
  });
  return { input, ...projected };
}
