/** Planner identity without loading executable kernels into admission or transport. */
import { sha256 } from "@noble/hashes/sha2.js";
import artifact from "./planner-wasm/artifact.json" with { type: "json" };
import runtime from "./planner-wasm/runtime-config.json" with { type: "json" };
const digest = sha256(new TextEncoder().encode(JSON.stringify({
  artifact, recipe: runtime.recipe, policyManifest: runtime.policy_manifest,
})));
export const RULES_MODEL_VERSION = `rules-planner-v22:${Array.from(digest, byte => byte.toString(16).padStart(2, "0")).join("")}`;
export const RULES_PLANNING_PROTOCOL = 10;
