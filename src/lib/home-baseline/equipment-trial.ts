import { projectHomeBaseline } from './browser';
import { loadHomeBaseline, type HomeRef } from './history';
import { equipmentInput, type EquipmentTrial } from './equipment';
import { createCaptureSource, type CaptureSource } from './source';
import { localDay } from '../../../supabase/functions/_shared/planner-wasm/calendar';
import { QUARTER_MS } from './model';

/** A trial reads the pinned facts directly, owns its pool chronology and never
 * regenerates/saves a reference capture to obtain simulation inputs. */
export function createEquipmentTrial(ref: HomeRef, reference: CaptureSource, trial: EquipmentTrial): CaptureSource {
  const pinned = structuredClone(trial);
  return createCaptureSource(ref, {
    resolveAnchor: async () => {
      const anchor = await reference.anchor();
      const latestMonth = localDay(new Date(Date.parse(anchor.latestEnd) - QUARTER_MS).toISOString(), anchor.snapshot.timezone).slice(0, 7);
      const saved = reference.saved(latestMonth);
      // The current report may legitimately retain a recently computed partial
      // month. Replay the trial to that exact cutoff, even if new readings arrived.
      return saved ? { ...anchor, latestEnd: saved.ledger.end } : anchor;
    },
    generate: async (home, anchor, period, signal, basis) => {
      const input = await loadHomeBaseline(home, anchor, period, signal);
      return projectHomeBaseline(equipmentInput(input, pinned), signal, basis);
    },
  });
}
