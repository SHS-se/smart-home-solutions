/**
 * How much power a home may draw from the grid.
 *
 * The home's owner answers this in the home profile on the website: the main
 * fuse, and under it the most they want drawn, which the fuse caps. The planner
 * takes its import limit from here and from nowhere else. It used to arrive in
 * each snapshot from a setting in the Home Assistant app, which automatic setup
 * filled from the inverter's power rating (13.2 kW for a home fused for 17.2).
 */

export const MAIN_FUSE_KEY = "main_fuse_a";
export const GRID_IMPORT_LIMIT_KEY = "grid_import_limit_kw";
export const MAIN_FUSES_A = [16, 20, 25, 35, 50, 63];

/** Three phases at the nominal 230 V. The questionnaire only describes three-phase connections. */
export function fuseLimitW(fuseA: number): number {
  return 3 * 230 * fuseA;
}

/** The fuse's limit as the profile shows it: whole tenths of a kW, never rounded above the fuse. */
export function fuseLimitKw(fuseA: number): number {
  return Math.floor(fuseLimitW(fuseA) / 100) / 10;
}

export function mainFuseA(answer: unknown): number | null {
  const fuse = typeof answer === "number" || typeof answer === "string" ? Number(answer) : Number.NaN;
  return MAIN_FUSES_A.includes(fuse) ? fuse : null;
}

/**
 * The limit the planner must keep to. The owner's own figure can only lower the
 * fuse's; one that is missing, not a number or not positive leaves the fuse's.
 */
export function gridImportLimitW(fuseA: number, chosenKw: unknown): number {
  const fuse = fuseLimitW(fuseA);
  const chosen = typeof chosenKw === "number" || (typeof chosenKw === "string" && chosenKw.trim() !== "")
    ? Number(chosenKw) * 1000 : Number.NaN;
  return Number.isFinite(chosen) && chosen > 0 ? Math.min(fuse, Math.round(chosen)) : fuse;
}

interface StoredAnswer { question_id: string; answer_value: unknown; answer_text: string | null }
const stored = (answer: StoredAnswer | undefined): unknown =>
  answer?.answer_value ?? (answer?.answer_text ? answer.answer_text : null);

/** Null when the home has not said what its main fuse is. */
export async function readHomeGridImportLimitW(
  // deno-lint-ignore no-explicit-any
  db: any,
  homeId: string,
): Promise<number | null> {
  const { data: questions, error: questionError } = await db.from("home_questions")
    .select("id, semantic_key").in("semantic_key", [MAIN_FUSE_KEY, GRID_IMPORT_LIMIT_KEY]);
  if (questionError) throw new Error(questionError.message);
  const ids = new Map<string, string>((questions ?? []).map((q: { id: string; semantic_key: string }) => [q.semantic_key, q.id]));
  if (!ids.has(MAIN_FUSE_KEY)) return null;
  const { data: answers, error: answerError } = await db.from("home_answers")
    .select("question_id, answer_value, answer_text").eq("home_id", homeId).in("question_id", [...ids.values()]);
  if (answerError) throw new Error(answerError.message);
  const byQuestion = new Map<string, StoredAnswer>((answers ?? []).map((a: StoredAnswer) => [a.question_id, a]));
  const fuse = mainFuseA(stored(byQuestion.get(ids.get(MAIN_FUSE_KEY)!)));
  if (fuse === null) return null;
  return gridImportLimitW(fuse, stored(byQuestion.get(ids.get(GRID_IMPORT_LIMIT_KEY) ?? "")));
}
