import { supabase } from '@/integrations/supabase/client';
import {
  normalizeHomeProfileBoolean,
  normalizeHomeProfileDate,
  normalizeHomeProfileNumber,
} from './home-profile-values';

async function fetchPrimaryHomeFunctionalAnswers(
  customerId: string,
  semanticKeys: string[],
): Promise<Record<string, unknown>> {
  if (semanticKeys.length === 0) return {};
  const { data: customer, error: customerError } = await supabase
    .from('customers')
    .select('primary_home_id')
    .eq('id', customerId)
    .maybeSingle();
  if (customerError) throw customerError;
  if (!customer?.primary_home_id) return {};

  const { data: questions, error: questionError } = await supabase
    .from('home_questions')
    .select('id, semantic_key')
    .in('semantic_key', semanticKeys);
  if (questionError) throw questionError;
  if (!questions?.length) return {};

  const { data: answers, error: answerError } = await supabase
    .from('home_answers')
    .select('question_id, answer_value, answer_text')
    .eq('home_id', customer.primary_home_id)
    .in('question_id', questions.map((question) => question.id));
  if (answerError) throw answerError;

  const answersByQuestion = new Map(
    (answers ?? []).map((answer) => [answer.question_id, answer]),
  );
  return Object.fromEntries(questions.flatMap((question) => {
    if (!question.semantic_key) return [];
    const answer = answersByQuestion.get(question.id);
    return [[
      question.semantic_key,
      answer?.answer_value ?? answer?.answer_text ?? null,
    ]];
  }));
}

export interface EnergyHistoryHomeProfileInputs {
  moveInDate: string | null;
  heatedAreaM2: number | null;
  hasSolar: boolean | null;
}

export async function fetchEnergyHistoryHomeProfileInputs(
  customerId: string,
): Promise<EnergyHistoryHomeProfileInputs> {
  const answers = await fetchPrimaryHomeFunctionalAnswers(customerId, [
    'move_in_date',
    'heated_area_m2',
    'has_solar',
  ]);
  return {
    moveInDate: normalizeHomeProfileDate(answers.move_in_date),
    heatedAreaM2: normalizeHomeProfileNumber(answers.heated_area_m2),
    hasSolar: normalizeHomeProfileBoolean(answers.has_solar),
  };
}
