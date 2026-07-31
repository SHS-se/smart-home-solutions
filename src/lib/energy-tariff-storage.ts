import { supabase } from '@/integrations/supabase/client';
import type { Json, Tables } from '@/integrations/supabase/types';

export type EnergyTariffProfile = Tables<'energy_tariff_profiles'>;
export type EnergyTariffVersion = Tables<'energy_tariff_versions'>;
export type EnergyTariffAssignment = Tables<'customer_energy_tariff_assignments'>;
export type EnergyTariffCalculation = Tables<'energy_tariff_calculations'>;

export type TariffConnectionType = 'three_phase' | 'single_phase' | 'apartment';
export type TariffApartmentBand = 'up_to_29' | '30_59' | '60_99' | '100_plus';
export type TariffGridArea =
  | 'dalarna_sodra_norrland_edsbyn'
  | 'stockholm'
  | 'vastkusten'
  | 'vastra_svealand_vastergotland';

export interface EnergyTariffConfiguration {
  connection_type: TariffConnectionType;
  fuse_a?: 16 | 20 | 25 | 35 | 50 | 63;
  apartment_band?: TariffApartmentBand;
  grid_area: TariffGridArea;
  production_enabled: boolean;
  energy_tax_reduced: boolean;
  include_vat: boolean;
  export_vat_registered: boolean;
}

export async function fetchEnergyTariffProfiles(): Promise<EnergyTariffProfile[]> {
  const { data, error } = await supabase
    .from('energy_tariff_profiles')
    .select('*')
    .order('provider_name', { ascending: true })
    .order('display_name', { ascending: true });
  if (error) throw error;
  return data ?? [];
}

export async function fetchEnergyTariffVersions(): Promise<EnergyTariffVersion[]> {
  const { data, error } = await supabase
    .from('energy_tariff_versions')
    .select('*')
    .order('valid_from', { ascending: false });
  if (error) throw error;
  return data ?? [];
}

export async function fetchCustomerEnergyTariffAssignments(
  customerId: string,
): Promise<EnergyTariffAssignment[]> {
  const { data, error } = await supabase
    .from('customer_energy_tariff_assignments')
    .select('*')
    .eq('customer_id', customerId)
    .order('valid_from', { ascending: false });
  if (error) throw error;
  return data ?? [];
}

export async function setCustomerEnergyTariffAssignment(params: {
  customerId: string;
  profileId: string;
  validFrom: string;
  configuration: EnergyTariffConfiguration;
}): Promise<string> {
  const { data, error } = await supabase.rpc('set_customer_energy_tariff_assignment', {
    p_customer_id: params.customerId,
    p_profile_id: params.profileId,
    p_valid_from: params.validFrom,
    p_configuration: params.configuration as unknown as Json,
  });
  if (error) throw error;
  if (!data) throw new Error('Tariff assignment was not saved');
  return data;
}

export async function fetchEnergyTariffCalculations(
  customerId: string,
): Promise<EnergyTariffCalculation[]> {
  const { data, error } = await supabase
    .from('energy_tariff_calculations')
    .select('*')
    .eq('customer_id', customerId)
    .order('billing_month', { ascending: true });
  if (error) throw error;
  return data ?? [];
}
