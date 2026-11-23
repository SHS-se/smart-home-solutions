import { z } from 'zod';
import { LEGACY_ROOM_RUN_POLICY, MAX_ROOM_HEATING_RUNS, ROOM_RUN_POLICY, ROOM_TRANSITION_POLICY } from '../../../supabase/functions/_shared/planner/models/room/run-evidence';

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
