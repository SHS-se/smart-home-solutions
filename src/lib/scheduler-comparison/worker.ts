import wasmUrl from '../../../supabase/functions/_shared/planner-wasm/solver.wasm?url';
import artifact from '../../../supabase/functions/_shared/planner-wasm/artifact.json';
import { createWasmPlanner } from '../../../supabase/functions/_shared/planner-wasm/core';
import { compareScheduler } from './comparison';
import { HOUSEHOLD } from '../planner-bench/household';
import type { ComparisonRequest } from './browser';

self.onmessage = async (event: MessageEvent<ComparisonRequest>) => {
  try {
    const response = await fetch(wasmUrl);
    if (!response.ok) throw new Error(`Could not load comparison engine: ${response.status}`);
    const bytes = new Uint8Array(await response.arrayBuffer());
    const hash = Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', bytes)), b => b.toString(16).padStart(2, '0')).join('');
    if (artifact.abi !== 8 || hash !== artifact.wasm_sha256) throw new Error('Unsupported or corrupt comparison engine');
    const { scenario, settings, criteria } = event.data;
    const result = await compareScheduler(scenario, HOUSEHOLD, settings, criteria, createWasmPlanner(bytes));
    self.postMessage({ result, engineHash: hash });
  } catch (error) {
    self.postMessage({ error: error instanceof Error ? error.message : String(error) });
  }
};
