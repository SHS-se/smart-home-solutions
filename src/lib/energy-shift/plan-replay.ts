import type { TimelineRange, TimelineRow } from './energy-timeline';

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
