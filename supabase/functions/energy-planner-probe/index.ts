import { createPlannerProbe } from '../_shared/planner-wasm/probe.ts';
import { SOLVER_BASE64 } from '../_shared/planner-wasm/solver-bytes.ts';
import build from '../_shared/planner-wasm/artifact.json' with { type: 'json' };
import recipe from './recipe.json' with { type: 'json' };

Deno.serve(
  createPlannerProbe(
    SOLVER_BASE64,
    build,
    recipe,
    Deno.env.get('PLANNER_PROBE_SECRET') ?? '',
    Deno.env.get('SUPABASE_URL') ?? '',
  ),
);
