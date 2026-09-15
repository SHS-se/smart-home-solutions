import type { OptimisationPlan, PlannedSlot } from './contracts';

/** Chart-only partition; it never changes executable commands or gross demand. */
export function consumptionPlanSlots(
  parent: Pick<OptimisationPlan, 'plans' | 'operating_scope'>,
  slots: readonly PlannedSlot[],
  execution: boolean,
): PlannedSlot[] {
  if (!execution || !parent.operating_scope) return [...slots];
  const indices = new Map(parent.plans.priority.slots.map((slot, index) => [Date.parse(slot.start), index]));
  return slots.map(slot => {
    const index = indices.get(Date.parse(slot.start));
    if (index === undefined) throw new Error('Consumption partition has no captured plan quarter');
    const loads = { ...slot.device_loads_w };
    for (const [key, demand] of Object.entries(parent.operating_scope!.external_demands)) {
      if (key in loads) throw new Error('Consumption partition counts an external device twice');
      loads[key] = index === 0 && demand.recent_observation !== null
        ? demand.recent_observation.average_w : demand.forecast_w_by_slot[index];
    }
    return { ...slot, device_loads_w: loads };
  });
}
