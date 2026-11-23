import { z } from 'zod';
import { LEGACY_ROOM_RUN_POLICY, MAX_ROOM_HEATING_RUNS, ROOM_RUN_POLICY, ROOM_TRANSITION_POLICY } from '../../../supabase/functions/_shared/planner/models/room/run-evidence';
import { ROOM_MEASURED_POLICY, ROOM_MEASUREMENT_METHOD } from '../../../supabase/functions/_shared/planner/models/room/measured-evidence';

const finite = z.number().finite();
const count = z.number().int().nonnegative();
const measuredLine = z.object({
  reference_outdoor_c: finite, intercept: finite, slope_per_c: finite, robust_scale: finite.nonnegative(),
  points: count, effective_points: finite.nonnegative(), constraint: z.enum(['rises', 'falls']),
  units: z.enum(['c_per_kwh', 'c_per_h']),
});

/** Published learner output only; the browser does not derive a fit from a page of runs. */
export const roomMeasuredEvidence = z.object({
  policy: z.literal(ROOM_MEASURED_POLICY), measurement_method: z.literal(ROOM_MEASUREMENT_METHOD),
  fitted_observations: count, residual_degrees_of_freedom: finite,
  observed_runs: count, heating_runs: count, cooling_runs: count, flagged_runs: count, unmeasured_runs: count,
  reference: z.object({ room_c: finite, house_c: finite }),
  lines: z.object({ heating: measuredLine.nullable(), cooling: measuredLine.nullable(),
    reference_heating: measuredLine.nullable(), reference_cooling: measuredLine.nullable() }),
  validation: z.object({ training_to: z.string().nullable(), observations: count,
    trajectory_mae_c: finite.nullable(), trajectory_bias_c: finite.nullable(),
    projected_trajectory_mae_c: finite.nullable().optional(), projected_trajectory_bias_c: finite.nullable().optional() }),
});

export const roomRunEvidence = z.object({
  policy: z.union([z.literal(ROOM_RUN_POLICY), z.literal(LEGACY_ROOM_RUN_POLICY)]),
  fitted_runs: z.number().int().min(0).max(MAX_ROOM_HEATING_RUNS),
  retained_runs: z.number().int().min(0).max(MAX_ROOM_HEATING_RUNS),
  suspect_runs: z.number().int().nonnegative(),
  provisional_runs: z.number().int().nonnegative(),
  oldest_run_at: z.string().nullable(),
  newest_run_at: z.string().nullable(),
});

export const roomTransitionEvidence = z.object({
  policy: z.literal(ROOM_TRANSITION_POLICY),
  fitted_transitions: z.number().int().positive(),
});
