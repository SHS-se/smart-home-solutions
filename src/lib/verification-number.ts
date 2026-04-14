import type { SupabaseClient } from '@supabase/supabase-js';
import type { Database } from '@/integrations/supabase/types';

/**
 * Verification number format: VYYMM-NNN
 *   V      — fixed prefix
 *   YY     — 2-digit year
 *   MM     — 2-digit month (zero-padded)
 *   NNN    — 3-digit sequential index (001–999)
 *
 * Examples:
 *   V2602-005 — 5th verification for February 2026
 *   V2601-015 — 15th verification for January 2026
 *   V2603-123 — 123rd verification for March 2026
 */

const VERIFICATION_NUMBER_PATTERN = /^V(\d{2})(\d{2})-(\d{3})$/;

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

  const next = maxSequence + 1;
  if (next > 999) {
    throw new Error(`Verification number overflow: month ${yy}${mm} already has 999 verifications`);
  }
  return `${prefix}${String(next).padStart(3, '0')}`;
}
