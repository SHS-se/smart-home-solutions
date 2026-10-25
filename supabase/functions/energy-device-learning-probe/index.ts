import { createDeviceLearningProbe } from "../_shared/device-learning-probe.ts";

Deno.serve(createDeviceLearningProbe(
  Deno.env.get("PLANNER_PROBE_SECRET") ?? "", Deno.env.get("SUPABASE_URL") ?? "",
));
