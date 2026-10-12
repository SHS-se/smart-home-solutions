import { z } from 'zod';
import { supabase } from '@/integrations/supabase/client';
import type { SupabaseClient } from '@supabase/supabase-js';
import type { HomeRef } from './history';

const installation = z.object({ equipment: z.enum(['solar', 'battery', 'bergvarme']), installed_month: z.string().regex(/^\d{4}-(0[1-9]|1[0-2])$/) }).strict();
export type RoiInstallation = z.infer<typeof installation>;
export async function fetchRoiInstallations(ref: HomeRef): Promise<RoiInstallation[]> {
  const { data, error } = await (supabase as unknown as SupabaseClient).from('energy_roi_installations').select('equipment,installed_month')
    .eq('customer_id', ref.customerId).eq('home_id', ref.homeId).order('equipment');
  if (error) throw new Error(error.message);
  return z.array(installation).parse(data);
}
