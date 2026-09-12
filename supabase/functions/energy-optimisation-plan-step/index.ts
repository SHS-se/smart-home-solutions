import { withTrafficMetrics } from "../_shared/edge-traffic.ts";
import { handleEnergyPlanningStep } from "../_shared/energy-planning-worker.ts";

Deno.serve(withTrafficMetrics("energy-optimisation-plan-step", (request) =>
  handleEnergyPlanningStep(
    request,
    Deno.env.get("ENERGY_PLANNING_SECRET") ?? "",
  )
));
