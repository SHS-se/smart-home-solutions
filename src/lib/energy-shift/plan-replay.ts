import type { TimelineRange, TimelineRow } from './energy-timeline';
import type { PlanKey, PortalOptimisationPlan } from './contracts';

/** Preserve the complete solve and bookmark the selected chart scenario. */
export function replayPlanSelection(
  plan: PortalOptimisationPlan,
  scenario: PlanKey,
  start: string,
) {
  const slots = plan.plans[scenario].slots;
  const index = slots.findIndex(slot => Date.parse(slot.start) === Date.parse(start));
  if (index < 0) throw new Error('Replay selection is outside the captured plan');
  const { thermal_projection: thermalProjection, ...plannerOutput } = plan;
  return {
    selection: { scenario, quarter_index: index, quarter_start: slots[index].start },
    expected: {
      planner_output: plannerOutput,
      thermal_projection: thermalProjection ?? null,
      selected_quarter: slots[index],
    },
  };
}

/** Chart measurements are diagnostic context, never replay planner inputs. */
export function replayHistory(
  timeline: readonly TimelineRow[],
  range: TimelineRange,
  timezone: string,
  selectedStart?: string | null,
) {
  return {
    source: 'chart_timeline',
    timezone,
    slot_minutes: 15,
    power_unit: 'W',
    soc_unit: 'fraction',
    price_unit: 'SEK/kWh',
    export_and_charge_power_sign: 'negative',
    selected_start: selectedStart ?? null,
    visible_window: {
      first_start: timeline[range.from]?.start ?? null,
      last_start: timeline[range.to - 1]?.start ?? null,
    },
    // Include all loaded history, even when the chart is zoomed to the plan.
    // Keep missing rows and nulls so absent readings never become zero demand.
    slots: timeline.filter(row => row.measured),
  };
}
