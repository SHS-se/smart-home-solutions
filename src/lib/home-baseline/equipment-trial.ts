import { projectHomeBaseline } from './browser';
import type { HomeRef } from './history';
import { equipmentInput, type EquipmentTrial } from './equipment';
import { createCaptureSource, type CaptureSource } from './source';

/** A trial has its own pool chronology and no durable report writer. */
export function createEquipmentTrial(ref: HomeRef, reference: CaptureSource, trial: EquipmentTrial): CaptureSource {
  const pinned = structuredClone(trial);
  return createCaptureSource(ref, {
    resolveAnchor: () => reference.anchor(),
    generate: async (_, __, period, signal, pool) => {
      const capture = await reference.capture(period, signal);
      return projectHomeBaseline(equipmentInput(capture.input, pinned), signal, pool);
    },
  });
}
