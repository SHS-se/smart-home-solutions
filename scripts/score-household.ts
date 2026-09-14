// deno run --allow-read scripts/score-household.ts path/to/resolved-case.json
// Reads data only; never imports an entrypoint supplied by a capsule.
import { z } from "zod";
import {
  createHouseholdScorer,
  HOUSEHOLD_SCORER_VERSION,
} from "../supabase/functions/_shared/household-score.ts";

const [path, ...extra] = Deno.args;
if (!path || extra.length) {
  throw new Error("Usage: score-household.ts resolved-case.json");
}
const input = z.object({
  problem: z.unknown(),
  candidates: z.array(z.unknown()).min(1),
}).strict()
  .parse(JSON.parse(await Deno.readTextFile(path)));
const scorer = createHouseholdScorer(input.problem);
const results = input.candidates.map((candidate) => scorer.score(candidate));
console.log(
  JSON.stringify(
    { scorer_version: HOUSEHOLD_SCORER_VERSION, results },
    null,
    2,
  ),
);
if (results.some((r) => r.status !== "scored")) Deno.exitCode = 1;
