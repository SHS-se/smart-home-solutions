// Read the same saved comfort preferences as the live planner, for the home
// supplying the bench's history. Capture them before workers run so every
// planner version and the referee use exactly the same targets.
import { caseTargets, type Targets } from "../src/lib/planner-bench/case.ts";
import type { HistorySource } from "./history.ts";

export async function homeComfortTargets(source: HistorySource): Promise<Targets> {
  const query = `energy_optimisation_comfort_targets?select=pool_target_c,ev_target_km&home_id=eq.${encodeURIComponent(source.homeId)}`;
  const response = await fetch(`${source.url}/rest/v1/${query}`, {
    headers: { apikey: source.key, Authorization: `Bearer ${source.key}` },
  });
  if (!response.ok) throw new Error(`Could not read the bench home's comfort preferences: ${response.status} ${await response.text()}`);
  const rows = await response.json() as { pool_target_c: number; ev_target_km: number }[];
  if (rows.length !== 1) throw new Error(`Expected saved comfort preferences for bench home ${source.homeId}.`);
  const comfort = { pool_c: rows[0].pool_target_c, ev_km: rows[0].ev_target_km };
  return caseTargets({ comfort });
}
