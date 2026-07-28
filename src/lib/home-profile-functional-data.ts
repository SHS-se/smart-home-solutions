import { supabase } from '@/integrations/supabase/client';
import { normalizeHomeProfileDate } from './home-profile-values';

export async function fetchPrimaryHomeFunctionalDate(
  customerId: string,
  semanticKey: string,
): Promise<string | null> {
  const { data: customer, error: customerError } = await supabase
    .from('customers')
    .select('primary_home_id')
    .eq('id', customerId)
    .maybeSingle();
  if (customerError) throw customerError;
  if (!customer?.primary_home_id) return null;

  const { data: question, error: questionError } = await supabase
    .from('home_questions')
    .select('id')
    .eq('semantic_key', semanticKey)
    .maybeSingle();
  if (questionError) throw questionError;
  if (!question) return null;

  const { data: answer, error: answerError } = await supabase
    .from('home_answers')
    .select('answer_value, answer_text')
    .eq('home_id', customer.primary_home_id)
    .eq('question_id', question.id)
    .maybeSingle();
  if (answerError) throw answerError;

  return normalizeHomeProfileDate(answer?.answer_value ?? answer?.answer_text);
}
