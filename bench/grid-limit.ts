import {
  GRID_IMPORT_LIMIT_KEY, MAIN_FUSE_KEY, homeGridImportLimitW,
  type GridLimitQuestion, type StoredGridLimitAnswer,
} from "../supabase/functions/_shared/home-grid-limit.ts";
import type { HistorySource } from "./history.ts";

/** Capture the history home's configured import limit before any planner workers run. */
export async function homeImportLimitW(source: HistorySource): Promise<number> {
  async function read<T>(table: string, params: Record<string, string>): Promise<T[]> {
    const response = await fetch(`${source.url}/rest/v1/${table}?${new URLSearchParams(params)}`, {
      headers: { apikey: source.key, Authorization: `Bearer ${source.key}` },
    });
    if (!response.ok) throw new Error(`Could not read the bench home's grid import limit: ${response.status} ${await response.text()}`);
    return response.json();
  }
  const questions = await read<GridLimitQuestion>("home_questions", {
    select: "id,semantic_key", semantic_key: `in.(${MAIN_FUSE_KEY},${GRID_IMPORT_LIMIT_KEY})`,
  });
  const answers = questions.length ? await read<StoredGridLimitAnswer>("home_answers", {
    select: "question_id,answer_value,answer_text", home_id: `eq.${source.homeId}`,
    question_id: `in.(${questions.map(q => q.id).join(",")})`,
  }) : [];
  const limit = homeGridImportLimitW(questions, answers);
  if (limit === null) throw new Error(`The bench home ${source.homeId} has no configured main fuse in its home profile.`);
  return limit;
}
