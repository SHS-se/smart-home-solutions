import { supabase } from '@/integrations/supabase/client';
import type { SupabaseClient } from '@supabase/supabase-js';
import { fetchAllRows } from '@/lib/fetch-all-rows';
import { loadCase, type BenchScenarioData, type BenchRecorded } from '../planner-bench/case';
import type { CriteriaOverrides } from '../planner-bench/types';

// Bench tables are TEST-only and deliberately absent from migrated Database types.
const db = supabase as unknown as SupabaseClient;
export interface ComparisonCase { id: string; name: string; revision: string; recorded_at: string | null }

export function fetchComparisonCases() {
  return fetchAllRows<ComparisonCase>((from, to) => db.from('bench_scenarios')
    .select('id,name,revision,recorded_at:recorded->>recorded_at').eq('archived', false).order('captured_at').order('id').range(from, to));
}

export async function fetchComparisonInput(id: string, revision: string) {
  const { data, error } = await db.from('bench_scenarios').select('dataset,recorded').eq('id', id).eq('revision', revision).single();
  if (error) throw new Error(error.message);
  const row = data as unknown as { dataset: BenchScenarioData; recorded: BenchRecorded };
  const { data: rules, error: ruleError } = await db.from('bench_rules').select('criteria').single();
  if (ruleError) throw new Error(ruleError.message);
  return { scenario: loadCase(row.dataset, row.recorded), criteria: (rules as unknown as { criteria: CriteriaOverrides }).criteria };
}
