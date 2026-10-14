import { z } from 'zod';
import type { SupabaseClient } from '@supabase/supabase-js';
import { supabase } from '@/integrations/supabase/client';
import type { HomeRef } from './history';

const row = z.object({ month_key: z.string().regex(/^\d{4}-(0[1-9]|1[0-2])$/), runs: z.number().int().nonnegative(),
  controlling: z.record(z.number().int().nonnegative()) }).strict();
/** Planning runs in one local month, and how many of them each device was under SHS control in. */
export interface ControlMonth { month: string; runs: number; controlling: Record<string, number> }

export async function fetchControlMonths(ref: HomeRef, from: string, to: string, timeZone: string): Promise<ControlMonth[]> {
  const { data, error } = await (supabase as unknown as SupabaseClient).rpc('get_energy_control_months', {
    p_customer_id: ref.customerId, p_home_id: ref.homeId, p_from: from, p_to: to, p_time_zone: timeZone });
  if (error) throw new Error(error.message);
  return z.array(row).parse(data ?? []).map(r => ({ month: r.month_key, runs: r.runs, controlling: r.controlling }));
}
