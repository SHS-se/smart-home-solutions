import { supabase } from '@/integrations/supabase/client';
import type { Json, Tables } from '@/integrations/supabase/types';

export const MAX_ENERGY_DATA_FILE_BYTES = 15 * 1024 * 1024;
export const ENERGY_PARSE_FAILURE_BUCKET = 'energy-parser-failures';
export const ENERGY_PARSE_FAILURE_STAFF_STATUS_QUERY_KEY = [
  'energy-parse-failure-staff-status',
] as const;

export type EnergyParseFailureRecord = Tables<'energy_parse_failures'>;
export type EnergyParseFailureCategory = 'document' | 'csv';

const SUPPORTED_MIME_TYPES = new Set([
  'application/pdf',
  'image/jpeg',
  'image/png',
  'image/webp',
  'image/heic',
  'image/heif',
  'text/csv',
  'application/vnd.ms-excel',
  'text/plain',
]);

const MIME_TYPES_BY_EXTENSION: Record<string, string> = {
  csv: 'text/csv',
  heic: 'image/heic',
  heif: 'image/heif',
  jpeg: 'image/jpeg',
  jpg: 'image/jpeg',
  pdf: 'application/pdf',
  png: 'image/png',
  txt: 'text/plain',
  webp: 'image/webp',
};

export function normalizeEnergyFileName(fileName: string): string {
  const normalized = fileName
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-zA-Z0-9._-]+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '');
  return normalized || 'energy-import';
}

export function resolvedEnergyFileMimeType(file: File): string {
  const declaredType = file.type.split(';', 1)[0].trim().toLocaleLowerCase();
  if (SUPPORTED_MIME_TYPES.has(declaredType)) return declaredType;

  const extension = file.name.toLocaleLowerCase().split('.').at(-1) ?? '';
  return (MIME_TYPES_BY_EXTENSION[extension] ?? declaredType) || 'application/octet-stream';
}

function bytesToHex(bytes: Uint8Array): string {
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('');
}

export async function sha256File(file: File): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', await file.arrayBuffer());
  return bytesToHex(new Uint8Array(digest));
}

export async function fetchEnergyParseFailures(
  customerId: string,
): Promise<EnergyParseFailureRecord[]> {
  const { data, error } = await supabase
    .from('energy_parse_failures')
    .select('*')
    .eq('customer_id', customerId)
    .order('created_at', { ascending: false })
    .order('id', { ascending: false });

  if (error) throw error;
  return data ?? [];
}

export async function fetchEnergyParseFailureStaffStatus(): Promise<{
  failures: EnergyParseFailureRecord[];
  total: number;
}> {
  const { data, error, count } = await supabase
    .from('energy_parse_failures')
    .select('*', { count: 'exact' })
    .order('created_at', { ascending: true })
    .order('id', { ascending: true })
    .limit(10);

  if (error) throw error;
  return {
    failures: data ?? [],
    total: count ?? data?.length ?? 0,
  };
}

async function findEnergyParseFailure(
  customerId: string,
  fileSha256: string,
): Promise<EnergyParseFailureRecord | null> {
  const { data, error } = await supabase
    .from('energy_parse_failures')
    .select('*')
    .eq('customer_id', customerId)
    .eq('file_sha256', fileSha256)
    .maybeSingle();

  if (error) throw error;
  return data;
}

export async function retainEnergyParseFailure(params: {
  customerId: string;
  file: File;
  fileCategory: EnergyParseFailureCategory;
  parserError: string;
  fileSha256?: string;
}): Promise<EnergyParseFailureRecord> {
  const {
    customerId,
    file,
    fileCategory,
  } = params;
  const parserError = params.parserError.trim().slice(0, 4000).trim();
  if (!parserError) throw new Error('A parser error is required before retaining a source file.');

  const fileSha256 = params.fileSha256 ?? await sha256File(file);
  const existingFailure = await findEnergyParseFailure(customerId, fileSha256);
  if (existingFailure) return existingFailure;

  const mimeType = resolvedEnergyFileMimeType(file);
  if (!SUPPORTED_MIME_TYPES.has(mimeType)) {
    throw new Error(`Unsupported file type (${mimeType}); the failed source was not retained.`);
  }

  const filePath = `${customerId}/${crypto.randomUUID()}/${normalizeEnergyFileName(file.name)}`;
  const { error: uploadError } = await supabase.storage
    .from(ENERGY_PARSE_FAILURE_BUCKET)
    .upload(filePath, file, {
      contentType: mimeType,
      upsert: false,
    });
  if (uploadError) throw uploadError;

  const failurePayload = {
    original_file_name: file.name.trim().slice(0, 255).trim() || 'energy-import',
    file_path: filePath,
    mime_type: mimeType,
    file_size_bytes: file.size,
    file_sha256: fileSha256,
    file_category: fileCategory,
    parser_error: parserError,
  } satisfies Json;

  const { data: failureId, error: recordError } = await supabase.rpc(
    'record_energy_parse_failure',
    {
      p_customer_id: customerId,
      p_failure: failurePayload,
    },
  );

  if (recordError || !failureId) {
    const { error: cleanupError } = await supabase.storage
      .from(ENERGY_PARSE_FAILURE_BUCKET)
      .remove([filePath]);
    if (cleanupError) {
      console.error('Failed to remove an unreferenced energy parser source:', cleanupError);
    }
    if (recordError?.code === '23505') {
      const racedFailure = await findEnergyParseFailure(customerId, fileSha256);
      if (racedFailure) return racedFailure;
    }
    throw recordError ?? new Error('The parse failure could not be recorded.');
  }

  const { data: failure, error: fetchError } = await supabase
    .from('energy_parse_failures')
    .select('*')
    .eq('id', failureId)
    .eq('customer_id', customerId)
    .single();
  if (fetchError) throw fetchError;
  return failure;
}

export async function deleteEnergyParseFailure(
  customerId: string,
  failure: EnergyParseFailureRecord,
): Promise<void> {
  if (failure.customer_id !== customerId) {
    throw new Error('The retained source does not belong to this customer.');
  }

  const { error: storageError } = await supabase.storage
    .from(ENERGY_PARSE_FAILURE_BUCKET)
    .remove([failure.file_path]);
  if (storageError) throw storageError;

  const { error: deleteError } = await supabase.rpc('delete_energy_parse_failure', {
    p_customer_id: customerId,
    p_failure_id: failure.id,
  });
  if (deleteError) throw deleteError;
}

export async function createEnergyParseFailureReviewUrl(
  customerId: string,
  failure: EnergyParseFailureRecord,
): Promise<string> {
  if (failure.customer_id !== customerId) {
    throw new Error('The retained source does not belong to this customer.');
  }

  const { data, error } = await supabase.storage
    .from(ENERGY_PARSE_FAILURE_BUCKET)
    .createSignedUrl(failure.file_path, 60);
  if (error) throw error;
  return data.signedUrl;
}

export async function removeEnergyParseFailureByHash(
  customerId: string,
  fileSha256: string,
): Promise<boolean> {
  const failure = await findEnergyParseFailure(customerId, fileSha256);
  if (!failure) return false;

  await deleteEnergyParseFailure(customerId, failure);
  return true;
}
