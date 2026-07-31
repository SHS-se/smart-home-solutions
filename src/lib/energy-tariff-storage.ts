import { supabase } from '@/integrations/supabase/client';
import type { Json, Tables } from '@/integrations/supabase/types';

export type EnergyTariffProfile = Tables<'energy_tariff_profiles'>;
export type EnergyTariffVersion = Tables<'energy_tariff_versions'>;
export type EnergyTariffSettings = Tables<'energy_tariff_settings'>;
export type EnergyTariffCalculation = Tables<'energy_tariff_calculations'>;

export type TariffGridArea =
  | 'dalarna_sodra_norrland_edsbyn'
  | 'stockholm'
  | 'vastkusten'
  | 'vastra_svealand_vastergotland';

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

export async function fetchEnergyTariffSettings(): Promise<EnergyTariffSettings> {
  const { data, error } = await supabase
    .from('energy_tariff_settings')
    .select('*')
    .eq('id', true)
    .single();
  if (error) throw error;
  return data;
}

export async function saveEnergyTariffSettings(params: {
  profileId: string;
  gridArea: TariffGridArea;
  energyTaxReduced: boolean;
  includeVat: boolean;
  exportVatRegistered: boolean;
}): Promise<void> {
  const { error } = await supabase.rpc('set_energy_tariff_settings', {
    p_profile_id: params.profileId,
    p_grid_area: params.gridArea,
    p_energy_tax_reduced: params.energyTaxReduced,
    p_include_vat: params.includeVat,
    p_export_vat_registered: params.exportVatRegistered,
  });
  if (error) throw error;
}

export async function publishEnergyTariffVersion(params: {
  profileId: string;
  revision: string;
  validFrom: string;
  calculationModel: string;
  definition: Json;
  sourceUrl: string;
}): Promise<string> {
  const { data, error } = await supabase.rpc('publish_energy_tariff_version', {
    p_profile_id: params.profileId,
    p_revision: params.revision,
    p_valid_from: params.validFrom,
    p_calculation_model: params.calculationModel,
    p_definition: params.definition,
    p_source_url: params.sourceUrl,
  });
  if (error) throw error;
  if (!data) throw new Error('Tariff version was not published');
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
