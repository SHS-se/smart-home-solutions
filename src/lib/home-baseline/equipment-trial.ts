import { projectHomeBaseline } from './browser';
import { loadHomeBaseline, type HomeRef } from './history';
import { equipmentInput, type EquipmentTrial } from './equipment';
import { createCaptureSource, type CaptureSource } from './source';

/** A trial reads the pinned facts directly, owns its pool chronology and never
 * regenerates/saves a reference capture to obtain simulation inputs. */
export function createEquipmentTrial(ref: HomeRef, reference: CaptureSource, trial: EquipmentTrial): CaptureSource {
  const pinned = structuredClone(trial);
  return createCaptureSource(ref, {
    resolveAnchor: () => reference.anchor(),
    generate: async (home, anchor, period, signal, pool) => {
      const input = await loadHomeBaseline(home, anchor, period, signal);
      return projectHomeBaseline(equipmentInput(input, pinned), signal, pool);
    },
  });
}
