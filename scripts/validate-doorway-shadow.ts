/** Paired forecast validation for private, frozen room histories. Runs offline. */
import { TRAINING_WINDOW_DAYS } from "../supabase/functions/_shared/thermal-training.ts";
import { fitRoomMeans } from "../supabase/functions/_shared/device-learning/room/mean-observations.ts";
import { fitDoorwayShadow, projectDoorwayShadow, ROOM_QUARTER_MS, type DoorwayObservation, type ShadowForecastOrigin } from "../supabase/functions/_shared/device-learning/room/doorway-shadow.ts";

const TRAINING_MS = TRAINING_WINDOW_DAYS * 86_400_000;
const HORIZONS = [1, 6, 12, 24] as const;

interface Errors {
  origins: number;
  baseline_abs: number;
  baseline_bias: number;
  doorway_abs: number;
  doorway_bias: number;
}

export interface DoorwayValidationInput {
  /** Each origin carries the training evidence actually available at capture. */
  origins: readonly (ShadowForecastOrigin & { training: readonly DoorwayObservation[] })[];
  /** The separately gathered target-room outcomes used only for scoring. */
  outcomes: readonly Pick<DoorwayObservation, "start_ms" | "room_c">[];
}

export function validateDoorwayShadow({ origins, outcomes }: DoorwayValidationInput) {
  const measured = new Map(outcomes.map(row => [row.start_ms, row.room_c]));
  const scores: Errors[] = HORIZONS.map(() => ({
    origins: 0, baseline_abs: 0, baseline_bias: 0, doorway_abs: 0, doorway_bias: 0,
  }));
  let fittedOrigins = 0;
  for (const origin of origins) {
    const training = origin.training.filter(q =>
      q.start_ms >= origin.start_ms - TRAINING_MS && q.start_ms + ROOM_QUARTER_MS <= origin.start_ms);
    const baseline = fitRoomMeans(training);
    if (!baseline.ok) continue;
    const fit = fitDoorwayShadow(training, baseline.model);
    if (fit.status !== "fitted") continue;
    fittedOrigins++;
    const predicted = projectDoorwayShadow(origin, baseline.model, fit);
    HORIZONS.forEach((hours, index) => {
      const estimate = predicted[hours * 4 - 1];
      if (!estimate) return;
      const observed = measured.get(estimate.start_ms);
      if (observed == null || !Number.isFinite(observed)) return;
      const baseError = estimate.baseline_c - observed;
      const doorwayError = estimate.doorway_c - observed;
      const score = scores[index];
      score.origins++;
      score.baseline_abs += Math.abs(baseError);
      score.baseline_bias += baseError;
      score.doorway_abs += Math.abs(doorwayError);
      score.doorway_bias += doorwayError;
    });
  }
  return { origins: origins.length, fitted_origins: fittedOrigins,
    scores: HORIZONS.map((hours, index) => {
      const score = scores[index], n = score.origins;
      return { hours, compared_origins: n,
        baseline_mae_c: n ? score.baseline_abs / n : null, baseline_bias_c: n ? score.baseline_bias / n : null,
        doorway_mae_c: n ? score.doorway_abs / n : null, doorway_bias_c: n ? score.doorway_bias / n : null };
    }) };
}

if (import.meta.main) {
  if (Deno.args.length !== 1) {
    throw new Error("Usage: deno run --allow-read scripts/validate-doorway-shadow.ts <private-capture.json>");
  }
  const input: DoorwayValidationInput = JSON.parse(await Deno.readTextFile(Deno.args[0]));
  if (!Array.isArray(input?.origins) || !Array.isArray(input?.outcomes)) {
    throw new Error("Expected captured forecast origins and separately observed outcomes");
  }
  console.log(JSON.stringify(validateDoorwayShadow(input), null, 2));
}
