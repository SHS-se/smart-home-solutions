import type { PostgrestError } from '@supabase/supabase-js';

/**
 * PostgREST silently caps unranged selects (1 000 rows on Supabase's default
 * config), so any "fetch everything" list or aggregation quietly truncates
 * once a table grows past the cap. This helper pages through the full result
 * with .range() until a short page arrives.
 *
 * The caller's query MUST have a deterministic .order() (ideally with a
 * unique tiebreaker column) — otherwise pages can overlap or skip rows.
 *
 * Usage:
 *   const rows = await fetchAllRows((from, to) =>
 *     supabase.from('acc_journal_lines').select('*').order('created_at').order('id').range(from, to));
 */
const PAGE_SIZE = 1000;

export async function fetchAllRows<T>(
  fetchPage: (from: number, to: number) => PromiseLike<{ data: T[] | null; error: PostgrestError | null }>,
): Promise<T[]> {
  const rows: T[] = [];
  for (let from = 0; ; from += PAGE_SIZE) {
    const { data, error } = await fetchPage(from, from + PAGE_SIZE - 1);
    if (error) throw error;
    const page = data ?? [];
    rows.push(...page);
    if (page.length < PAGE_SIZE) return rows;
  }
}
