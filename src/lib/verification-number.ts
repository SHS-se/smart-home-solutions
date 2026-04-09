import type { SupabaseClient } from '@supabase/supabase-js';
import type { Database } from '@/integrations/supabase/types';

const VERIFICATION_NUMBER_PATTERN = /^V-(\d{4})-(\d+)$/;

export async function allocateNextVerificationNumber(
  supabase: SupabaseClient<Database>,
  verificationDate: string,
): Promise<string> {
  const year = new Date(verificationDate).getFullYear();
  if (!Number.isFinite(year)) {
    throw new Error('Invalid verification date');
  }

  const { data, error } = await supabase
    .from('acc_verifications')
    .select('verification_number')
    .like('verification_number', `V-${year}-%`);

  if (error) throw error;

  const maxSequence = (data || []).reduce((currentMax, row) => {
    const match = row.verification_number?.match(VERIFICATION_NUMBER_PATTERN);
    if (!match) return currentMax;
    const [, matchYear, sequence] = match;
    if (Number(matchYear) !== year) return currentMax;
    return Math.max(currentMax, Number(sequence));
  }, 0);

  return `V-${year}-${String(maxSequence + 1).padStart(3, '0')}`;
}
