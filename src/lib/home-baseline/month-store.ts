import type { SupabaseClient } from '@supabase/supabase-js';
import { supabase } from '@/integrations/supabase/client';
import { CALCULATION_VERSION, compactModel, parseSavedReport, type MonthStore } from './saved-months';

const db = supabase as unknown as SupabaseClient;
const checked = <T>({ data, error }: { data: T; error: { message: string } | null }) => { if (error) throw new Error(error.message); return data; };
export const monthStore: MonthStore = {
  async read(ref, signal) {
    const row = checked(await db.from('energy_roi_reports').select('generation,version,model,months')
      .eq('home_id', ref.homeId).eq('customer_id', ref.customerId).eq('version', CALCULATION_VERSION).abortSignal(signal).maybeSingle());
    if (!row) return null;
    const checkpoints = checked(await db.from('energy_roi_pool_checkpoints').select('month,checkpoint')
      .eq('home_id', ref.homeId).eq('customer_id', ref.customerId).eq('generation', row.generation).abortSignal(signal));
    return parseSavedReport({ ...row, checkpoints: Object.fromEntries((checkpoints ?? []).map(r => [r.month, r.checkpoint])) });
  },
  async pin(ref, model, expectedGeneration, signal) {
    const row = checked(await db.rpc('pin_energy_roi_report', { p_home_id: ref.homeId, p_customer_id: ref.customerId,
      p_version: CALCULATION_VERSION, p_model: compactModel(model), p_expected_generation: expectedGeneration }).abortSignal(signal));
    return parseSavedReport(row);
  },
  async save(ref, generation, ledger, inputHash, expectedHash, signal) {
    const row = checked(await db.rpc('save_energy_roi_month', { p_home_id: ref.homeId, p_customer_id: ref.customerId,
      p_generation: generation, p_version: CALCULATION_VERSION, p_ledger: ledger, p_input_hash: inputHash, p_expected_hash: expectedHash }).abortSignal(signal));
    const report = parseSavedReport(row);
    return report.months[ledger.month];
  },
};
