import { loadHomeBaselineFrame, type HomeRef } from './history';
import { BaselineGenerationError, type BaselineInput, type BaselineResult } from './model';

export interface BaselineResponse { result: BaselineResult; engineHash: string }
export interface BaselineCapture extends BaselineResponse { input: BaselineInput }

export async function generateHomeBaseline(ref: HomeRef, end: string | null, signal: AbortSignal): Promise<BaselineCapture> {
  const input = await loadHomeBaselineFrame(ref, end, signal);
  try {
    const projected = await new Promise<BaselineResponse>((resolve, reject) => {
      if (signal.aborted) { reject(new DOMException('Cancelled', 'AbortError')); return; }
      const worker = new Worker(new URL('./worker.ts', import.meta.url), { type: 'module' });
      const cleanup = () => { worker.terminate(); signal.removeEventListener('abort', cancel); };
      const cancel = () => { cleanup(); reject(new DOMException('Cancelled', 'AbortError')); };
      signal.addEventListener('abort', cancel, { once: true });
      worker.onmessage = (event: MessageEvent<BaselineResponse & { error?: string }>) => {
        cleanup();
        if (event.data.error) reject(new Error(event.data.error)); else resolve(event.data);
      };
      worker.onerror = event => { cleanup(); reject(new Error(event.message || 'Default model worker failed')); };
      worker.postMessage(input);
    });
    return { input, ...projected };
  } catch (error) { throw new BaselineGenerationError(error instanceof Error ? error.message : String(error), input.end); }
}
