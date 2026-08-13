import { supabase } from '@/integrations/supabase/client';
import {
  calculateHeatedAtempM2,
  normalizeHomeProfileBoolean,
  normalizeHomeProfileDate,
  normalizeHomeProfileNumber,
} from './home-profile-values';
import {
  normalizeDwelling,
  normalizeHeating,
  type DwellingArchetype,
  type HeatingArchetype,
} from './energy-archetypes';

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
  heatedBoareaM2: number | null;
  heatedBiareaM2: number | null;
  heatedAreaM2: number | null;
  hasSolar: boolean | null;
  /** Archetype key for the cold-start prior — see energy-archetypes.ts. */
  yearBuilt: number | null;
  dwelling: DwellingArchetype | null;
  heating: HeatingArchetype | null;
}

export async function fetchEnergyHistoryHomeProfileInputs(
  customerId: string,
): Promise<EnergyHistoryHomeProfileInputs> {
  const answers = await fetchPrimaryHomeFunctionalAnswers(customerId, [
    'move_in_date',
    'heated_boarea_m2',
    'heated_biarea_m2',
    'has_solar',
    'year_built',
    'dwelling_type',
    'heating_types',
  ]);
  const heatedBoareaM2 = normalizeHomeProfileNumber(answers.heated_boarea_m2);
  const heatedBiareaM2 = normalizeHomeProfileNumber(answers.heated_biarea_m2);
  return {
    moveInDate: normalizeHomeProfileDate(answers.move_in_date),
    heatedBoareaM2,
    heatedBiareaM2,
    heatedAreaM2: calculateHeatedAtempM2(heatedBoareaM2, heatedBiareaM2),
    hasSolar: normalizeHomeProfileBoolean(answers.has_solar),
    yearBuilt: normalizeHomeProfileNumber(answers.year_built),
    dwelling: normalizeDwelling(answers.dwelling_type),
    heating: normalizeHeating(answers.heating_types),
  };
}
