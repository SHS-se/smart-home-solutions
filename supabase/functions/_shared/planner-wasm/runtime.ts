import { sha256 } from "@noble/hashes/sha2.js";
import artifact from "./artifact.json" with { type: "json" };
import { SOLVER_BASE64 } from "./solver-bytes.ts";
import { createWasmPlanner } from "./core.ts";
import { planningStage, type PlanningTrace } from "../planning-trace.ts";

let compiled: ReturnType<typeof createWasmPlanner> | undefined;
/** Room preparation and household selection share one verified native module. */
export function nativePlanner(trace?: PlanningTrace): ReturnType<typeof createWasmPlanner> {
  return planningStage(trace, "wasm_initialise", () => {
    if (compiled) return compiled;
    const bytes = planningStage(trace, "wasm_artifact_decode", () => {
      const binary = atob(SOLVER_BASE64);
      const decoded = new Uint8Array(binary.length);
      for (let i = 0; i < binary.length; i++) decoded[i] = binary.charCodeAt(i);
      const hash = Array.from(sha256(decoded), b => b.toString(16).padStart(2, "0")).join("");
      if (artifact.abi !== 13 || hash !== artifact.wasm_sha256) throw new Error("Rules planner artifact is missing, obsolete or corrupt");
      return decoded;
    });
    compiled = planningStage(trace, "wasm_compile", () => createWasmPlanner(bytes));
    return compiled;
  }, { cold: !compiled });
}
