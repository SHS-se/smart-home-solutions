import { createClient } from "https://esm.sh/@supabase/supabase-js@2.57.2";
import { withTrafficMetrics } from "../_shared/edge-traffic.ts";
import { handleEnergyPlanningStep } from "../_shared/energy-planning-worker.ts";

Deno.serve(withTrafficMetrics("energy-optimisation-plan-step", (request) =>
  handleEnergyPlanningStep(
    request,
    Deno.env.get("ENERGY_PLANNING_SECRET") ?? "",
    () => createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
      { auth: { persistSession: false } }),
  )
));
