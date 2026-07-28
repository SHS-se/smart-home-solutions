import { supabase } from '@/integrations/supabase/client';
import type { Json, Tables, TablesUpdate } from '@/integrations/supabase/types';
import {
  parseEnergyUsageCsv,
  type ParsedEnergyUsageCsv,
} from '@/lib/energy-usage-parser';
import { sha256File } from '@/lib/energy-billing-storage';
import { fetchAllRows } from '@/lib/fetch-all-rows';

export const SHARED_WEATHER_DATASET_KEY = 'stockholm-taby';
export const MAX_ENERGY_USAGE_CSV_FILE_BYTES = 5 * 1024 * 1024;

export type EnergyUsageReadingRecord = Tables<'energy_usage_readings'>;
export type EnergyWeatherDatasetRecord = Tables<'energy_weather_datasets'>;
export type EnergyWeatherObservationRecord = Tables<'energy_weather_observations'>;
export type EnergyHistoryNoteRecord = Tables<'energy_history_notes'>;

export class EnergyUsageImportError extends Error {
  constructor(
    public readonly code: 'duplicate' | 'save_failed',
    message: string,
  ) {
    super(message);
    this.name = 'EnergyUsageImportError';
  }
}

export interface TimelineNoteValues {
  noteDate: string;
  eventText: string;
}

export async function fetchEnergyUsageReadings(
  customerId: string,
): Promise<EnergyUsageReadingRecord[]> {
  return fetchAllRows<EnergyUsageReadingRecord>((from, to) => supabase
    .from('energy_usage_readings')
    .select('*')
    .eq('customer_id', customerId)
    .order('reading_date', { ascending: true })
    .order('id', { ascending: true })
    .range(from, to));
}

export async function fetchSharedWeatherDataset(): Promise<EnergyWeatherDatasetRecord> {
  const { data, error } = await supabase
    .from('energy_weather_datasets')
    .select('*')
    .eq('dataset_key', SHARED_WEATHER_DATASET_KEY)
    .single();
  if (error) throw error;
  return data;
}

export async function fetchSharedWeatherObservations(
  startDate: string,
  endDate: string,
): Promise<EnergyWeatherObservationRecord[]> {
  if (!startDate || !endDate || startDate > endDate) {
    throw new Error('A valid energy-usage date range is required to load weather observations.');
  }

  return fetchAllRows<EnergyWeatherObservationRecord>((from, to) => supabase
    .from('energy_weather_observations')
    .select('*')
    .eq('dataset_key', SHARED_WEATHER_DATASET_KEY)
    .gte('observed_on', startDate)
    .lte('observed_on', endDate)
    .order('observed_on', { ascending: true })
    .order('id', { ascending: true })
    .range(from, to));
}

export async function importEnergyUsageCsv(params: {
  customerId: string;
  file: File;
  parsed?: ParsedEnergyUsageCsv;
}): Promise<string> {
  const { customerId, file } = params;
  const parsed = params.parsed ?? parseEnergyUsageCsv(await file.text(), file.name);
  const fileSha256 = await sha256File(file);
  const readings = parsed.readings.map((reading) => ({
    reading_date: reading.readingDate,
    consumption_kwh: reading.consumptionKwh,
  })) satisfies Json[];

  const { data, error } = await supabase.rpc('import_energy_usage_readings', {
    p_customer_id: customerId,
    p_original_file_name: file.name,
    p_file_sha256: fileSha256,
    p_readings: readings,
  });

  if (error || !data) {
    const code = error?.code === '23505' ? 'duplicate' : 'save_failed';
    throw new EnergyUsageImportError(code, error?.message ?? 'Energy usage was not saved');
  }
  return data;
}

export async function fetchEnergyHistoryNotes(
  customerId: string,
): Promise<EnergyHistoryNoteRecord[]> {
  return fetchAllRows<EnergyHistoryNoteRecord>((from, to) => supabase
    .from('energy_history_notes')
    .select('*')
    .eq('customer_id', customerId)
    .order('note_date', { ascending: true })
    .order('created_at', { ascending: true })
    .order('id', { ascending: true })
    .range(from, to));
}

async function currentUserId(): Promise<string> {
  const { data, error } = await supabase.auth.getUser();
  if (error || !data.user) throw new Error('You must be signed in to edit energy-history notes.');
  return data.user.id;
}

function notePayload(customerId: string, userId: string, values: TimelineNoteValues) {
  return {
    customer_id: customerId,
    note_date: values.noteDate,
    event_text: values.eventText.trim(),
    created_by: userId,
    updated_by: userId,
  };
}

export async function createEnergyHistoryNote(
  customerId: string,
  values: TimelineNoteValues,
): Promise<EnergyHistoryNoteRecord> {
  const userId = await currentUserId();
  const { data, error } = await supabase
    .from('energy_history_notes')
    .insert(notePayload(customerId, userId, values))
    .select('*')
    .single();

  if (error) throw error;
  return data;
}

export async function updateEnergyHistoryNote(
  customerId: string,
  noteId: string,
  values: TimelineNoteValues,
): Promise<EnergyHistoryNoteRecord> {
  const userId = await currentUserId();
  const update: TablesUpdate<'energy_history_notes'> = {
    note_date: values.noteDate,
    event_text: values.eventText.trim(),
    updated_by: userId,
  };
  const { data, error } = await supabase
    .from('energy_history_notes')
    .update(update)
    .eq('id', noteId)
    .eq('customer_id', customerId)
    .select('*')
    .single();

  if (error) throw error;
  return data;
}

export async function deleteEnergyHistoryNote(
  customerId: string,
  noteId: string,
): Promise<void> {
  const { data, error } = await supabase
    .from('energy_history_notes')
    .delete()
    .eq('id', noteId)
    .eq('customer_id', customerId)
    .select('id')
    .maybeSingle();
  if (error) throw error;
  if (!data) {
    throw new Error('The note was not found or you do not have permission to delete it.');
  }
}
