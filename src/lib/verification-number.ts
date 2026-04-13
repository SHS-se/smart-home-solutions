import type { SupabaseClient } from '@supabase/supabase-js';
import type { Database } from '@/integrations/supabase/types';

/**
 * Verification number format: VYYMM-N
 *   V      — fixed prefix
 *   YY     — 2-digit year
 *   MM     — 2-digit month (zero-padded)
 *   N      — sequential index within that month (not zero-padded)
 *
 * Examples:
 *   V2602-5   — 5th verification for February 2026
 *   V2601-15  — 15th verification for January 2026
 *   V2603-123 — 123rd verification for March 2026
 */

const VERIFICATION_NUMBER_PATTERN = /^V(\d{2})(\d{2})-(\d+)$/;

export async function allocateNextVerificationNumber(
  supabase: SupabaseClient<Database>,
  verificationDate: string,
): Promise<string> {
  const date = new Date(verificationDate);
  const year = date.getFullYear();
  const month = date.getMonth() + 1;
  if (!Number.isFinite(year) || !Number.isFinite(month)) {
    throw new Error('Invalid verification date');
  }

  const yy = String(year).slice(-2);
  const mm = String(month).padStart(2, '0');
  const prefix = `V${yy}${mm}-`;

  const { data, error } = await supabase
    .from('acc_verifications')
    .select('verification_number')
    .like('verification_number', `${prefix}%`);

  if (error) throw error;

  const maxSequence = (data || []).reduce((currentMax, row) => {
    const match = row.verification_number?.match(VERIFICATION_NUMBER_PATTERN);
    if (!match) return currentMax;
    const [, matchYY, matchMM, sequence] = match;
    if (matchYY !== yy || matchMM !== mm) return currentMax;
    return Math.max(currentMax, Number(sequence));
  }, 0);

  return `${prefix}${maxSequence + 1}`;
}
