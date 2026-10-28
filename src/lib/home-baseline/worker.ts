import wasmUrl from '../../../supabase/functions/_shared/planner-wasm/solver.wasm?url';
import artifact from '../../../supabase/functions/_shared/planner-wasm/artifact.json';
import { createWasmReplayPlanner } from '../../../supabase/functions/_shared/planner-wasm/core';
import type { BaselineInput } from './model';
import { compareModels } from './model-comparison';

self.onmessage = async (event: MessageEvent<BaselineInput>) => {
  try {
    const response = await fetch(wasmUrl);
    if (!response.ok) throw new Error(`Could not load default model engine: ${response.status}`);
    const bytes = new Uint8Array(await response.arrayBuffer());
    const hash = Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', bytes)), b => b.toString(16).padStart(2, '0')).join('');
    if (artifact.abi !== 14 || hash !== artifact.wasm_sha256) throw new Error('Unsupported or corrupt default model engine');
    const compared = compareModels(event.data, createWasmReplayPlanner(bytes));
    self.postMessage({ ...compared, engineHash: hash });
  } catch (error) {
    self.postMessage({ error: error instanceof Error ? error.message : String(error) });
  }
};
