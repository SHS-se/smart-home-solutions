import {
  evaluateVisibility,
  getOperatorsForType,
  parseAnswerText,
  type DisplayRule,
  type TreeQuestion,
} from './questionnaire-engine.ts';

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

Deno.test('date questions expose chronological visibility operators', () => {
  const operators = getOperatorsForType('date');
  assert(operators.includes('gte'), 'date questions should support on-or-after conditions');
  assert(operators.includes('lt'), 'date questions should support before conditions');
});

Deno.test('date visibility rules compare ISO dates chronologically', () => {
  const questions: TreeQuestion[] = [
    {
      id: 'move-in',
      parent_question_id: null,
      order_index: 0,
      question_type: 'date',
      is_active: true,
    },
    {
      id: 'follow-up',
      parent_question_id: null,
      order_index: 1,
      question_type: 'text',
      is_active: true,
    },
  ];
  const rules: DisplayRule[] = [{
    id: 'rule',
    question_id: 'follow-up',
    depends_on_question_id: 'move-in',
    logic_group: 0,
    operator: 'gte',
    compare_value: '2021-03-13',
  }];

  assert(
    evaluateVisibility('follow-up', rules, { 'move-in': '2021-03-13' }, questions),
    'the boundary date should satisfy gte',
  );
  assert(
    !evaluateVisibility('follow-up', rules, { 'move-in': '2021-03-12' }, questions),
    'an earlier date should not satisfy gte',
  );
});

Deno.test('date answer text remains an ISO date string', () => {
  assert(
    parseAnswerText('2021-03-13', 'date') === '2021-03-13',
    'date answer should remain a stable ISO string',
  );
});
