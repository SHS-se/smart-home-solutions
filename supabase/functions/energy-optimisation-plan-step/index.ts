import { handleEnergyPlanningStep } from "../_shared/energy-planning-worker.ts";

Deno.serve((request) =>
  handleEnergyPlanningStep(
    request,
    Deno.env.get("ENERGY_PLANNING_SECRET") ?? "",
  )
);
