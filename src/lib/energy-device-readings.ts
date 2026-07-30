import { supabase } from '@/integrations/supabase/client';
import type { Tables } from '@/integrations/supabase/types';
import { fetchAllRows } from '@/lib/fetch-all-rows';
import { SHARED_WEATHER_DATASET_KEY } from '@/lib/energy-temperature-storage';

export type EnergyDeviceReadingRecord = Tables<'energy_device_readings'>;
export type WeatherObservationRecord = Tables<'energy_weather_observations'>;

/** All daily category readings pushed by the customer's Home Assistant. */
export async function fetchEnergyDeviceReadings(
  customerId: string,
): Promise<EnergyDeviceReadingRecord[]> {
  return fetchAllRows<EnergyDeviceReadingRecord>((from, to) => supabase
    .from('energy_device_readings')
    .select('*')
    .eq('customer_id', customerId)
    .order('reading_date', { ascending: true })
    .order('id', { ascending: true })
    .range(from, to));
}

/**
 * The full shared weather series (all years), used both for the rolling
 * window and to derive a normal-year HDD reference.
 */
export async function fetchAllWeatherObservations(): Promise<WeatherObservationRecord[]> {
  return fetchAllRows<WeatherObservationRecord>((from, to) => supabase
    .from('energy_weather_observations')
    .select('*')
    .eq('dataset_key', SHARED_WEATHER_DATASET_KEY)
    .order('observed_on', { ascending: true })
    .order('id', { ascending: true })
    .range(from, to));
}

/** Latest reading date per device token, for "last data received" display. */
export async function fetchLatestReadingDateByToken(
  customerId: string,
): Promise<Map<string, string>> {
  const { data, error } = await supabase
    .from('energy_device_readings')
    .select('device_token_id, reading_date')
    .eq('customer_id', customerId)
    .order('reading_date', { ascending: false })
    .limit(200);
  if (error) throw error;
  const latest = new Map<string, string>();
  for (const row of data ?? []) {
    if (!row.device_token_id) continue;
    if (!latest.has(row.device_token_id)) {
      latest.set(row.device_token_id, row.reading_date);
    }
  }
  return latest;
}
