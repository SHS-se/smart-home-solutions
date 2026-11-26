import type { TimelineRange, TimelineRow } from './energy-timeline';
import type { PlanKey, PortalOptimisationPlan } from './contracts';
import type { CapturedRulesInput } from '../../../supabase/functions/_shared/rules-planning-capture';

/** The archive already contains the exact completed arguments; never rebuild them from current settings. */
export function replayExecution(archive: unknown) {
  const record = (value: unknown): value is Record<string, unknown> =>
    value !== null && typeof value === 'object' && !Array.isArray(value);
  if (!record(archive) || !record(archive.input) || !record(archive.input.snapshot) ||
    typeof archive.planner_version !== 'string' || !archive.planner_version ||
    archive.input.model_version !== archive.planner_version ||
    typeof archive.runtime_version !== 'string' || !archive.runtime_version ||
    typeof archive.snapshot_hash !== 'string' || !archive.snapshot_hash ||
    'room_network_capture' in archive.input.snapshot ||
    !record(archive.input.approved_policy) || !('reference' in archive.input) ||
    typeof archive.input.now !== 'string') {
    throw new Error('The plan has no complete archived execution input');
  }
  return {
    entrypoint: {
      module: 'supabase/functions/_shared/rules-planning-execution.ts',
      export: 'executeRulesPlanning',
      argument_order: ['capture'],
      invocation: 'executeRulesPlanning(arguments).plan',
      arguments: archive.input as CapturedRulesInput,
    },
    input_hash: archive.snapshot_hash,
    planner_version: archive.planner_version,
    runtime_version: archive.runtime_version,
  };
}

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

/** What the replay file holds, said beside its button where the plan has no score to explain. */
export const replayDescription = (t: (sv: string, en: string) => string) => t(
  'Hela planen med indata, uppmätt historik och anropet som återskapar den.',
  'The whole plan with its inputs, measured history, and the call that reproduces it.',
);
