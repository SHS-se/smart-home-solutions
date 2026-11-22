import { z } from 'zod';
import { MAX_ROOM_HEATING_RUNS, ROOM_RUN_POLICY } from '../../../supabase/functions/_shared/planner/models/room/run-evidence';

export const roomRunEvidence = z.object({
  policy: z.literal(ROOM_RUN_POLICY),
  fitted_runs: z.number().int().min(0).max(MAX_ROOM_HEATING_RUNS),
  retained_runs: z.number().int().min(0).max(MAX_ROOM_HEATING_RUNS),
  suspect_runs: z.number().int().nonnegative(),
  provisional_runs: z.number().int().nonnegative(),
  oldest_run_at: z.string().nullable(),
  newest_run_at: z.string().nullable(),
});
