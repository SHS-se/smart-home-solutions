/** Planner identity without loading executable kernels into admission or transport. */
import { sha256 } from "@noble/hashes/sha2.js";
import artifact from "./planner-wasm/artifact.json" with { type: "json" };
import runtime from "./planner-wasm/runtime-config.json" with { type: "json" };
const digest = sha256(new TextEncoder().encode(JSON.stringify({
  artifact, recipe: runtime.recipe, policyManifest: runtime.policy_manifest,
})));
export const RULES_MODEL_VERSION = `rules-planner-v22:${Array.from(digest, byte => byte.toString(16).padStart(2, "0")).join("")}`;
export const RULES_PLANNING_PROTOCOL = 10;

/**
 * The planner and battery model an execution contract was made with. The executor
 * takes identities of at most 128 characters and these parts alone exceed that, so
 * this is their fixed-length digest.
 */
export function executionModelRevision(modelVersion: string, battery: { conversion: { revision: string }; charge_efficiency: number; discharge_efficiency: number }): string {
  const identity = `${modelVersion}:${battery.conversion.revision}:terminal-storage:${battery.charge_efficiency}:${battery.discharge_efficiency}`;
  return `sha256:${Array.from(sha256(new TextEncoder().encode(identity)), byte => byte.toString(16).padStart(2, "0")).join("")}`;
}
