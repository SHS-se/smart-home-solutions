/** Run only a requested commit's native rules planner. */
import { diskTree } from "../scripts/module-graph.ts";
import { usesRulePlanner } from "./planner-version.ts";
import { adaptPlanner, type LoadedPlanner } from "./execution.ts";
export { ADAPTER_VERSION } from "./execution.ts";

export async function loadPlanner(root: string): Promise<LoadedPlanner> {
  if (usesRulePlanner(diskTree(root))) {
    // Load both forecast preparation and frozen Wasm from the requested commit,
    // never the harness's current engine or a substitute on failure.
    const candidate: typeof import("./wasm-planner.ts") = await import(
      `file://${root}/bench/wasm-planner.ts`
    );
    const planner = await candidate.loadWasmCandidate(root);
    return adaptPlanner(candidate, planner);
  }
  throw new Error("This commit has no supported native rules planner artifact.");
}
