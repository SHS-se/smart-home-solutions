/**
 * Questionnaire Decision-Tree Engine
 *
 * Shared logic for flattening question trees, evaluating conditional visibility,
 * detecting cycles, and mapping question types to valid operators.
 */

// ── Types ───────────────────────────────────────────────────────────────────

export type QuestionType = 'text' | 'boolean' | 'single_choice' | 'multi_choice' | 'number' | 'date';

export type Operator =
  | 'equals' | 'not_equals'
  | 'contains' | 'not_contains'
  | 'gt' | 'lt' | 'gte' | 'lte'
  | 'is_true' | 'is_false'
  | 'is_any_of' | 'is_not_any_of';

export interface TreeQuestion {
  id: string;
  parent_question_id: string | null;
  order_index: number;
  question_type: QuestionType;
  is_active: boolean;
  [key: string]: unknown; // allow extra fields
}

export interface FlatQuestion extends TreeQuestion {
  depth: number;
}

export interface DisplayRule {
  id: string;
  question_id: string;
  depends_on_question_id: string;
  logic_group: number;
  operator: Operator;
  compare_value: unknown; // jsonb
}

export type AnswerMap = Record<string, unknown>; // question_id → answer_value (jsonb)

// ── Flatten Tree ────────────────────────────────────────────────────────────

/**
 * Depth-first flatten of questions based on parent_question_id + order_index.
 */
export function flattenTree(questions: TreeQuestion[]): FlatQuestion[] {
  const childMap = new Map<string | null, TreeQuestion[]>();
  for (const q of questions) {
    const parent = q.parent_question_id ?? null;
    if (!childMap.has(parent)) childMap.set(parent, []);
    childMap.get(parent)!.push(q);
  }
  // Sort children by order_index
  for (const children of childMap.values()) {
    children.sort((a, b) => a.order_index - b.order_index);
  }

  const result: FlatQuestion[] = [];
  const walk = (parentId: string | null, depth: number) => {
    const children = childMap.get(parentId);
    if (!children) return;
    for (const child of children) {
      result.push({ ...child, depth });
      walk(child.id, depth + 1);
    }
  };
  walk(null, 0);
  return result;
}

// ── Operators by Type ───────────────────────────────────────────────────────

const OPERATOR_MAP: Record<QuestionType, Operator[]> = {
  boolean: ['is_true', 'is_false'],
  text: ['equals', 'not_equals', 'contains', 'not_contains'],
  number: ['equals', 'not_equals', 'gt', 'lt', 'gte', 'lte'],
  date: ['equals', 'not_equals', 'gt', 'lt', 'gte', 'lte'],
  single_choice: ['equals', 'not_equals', 'is_any_of', 'is_not_any_of'],
  multi_choice: ['contains', 'not_contains', 'is_any_of', 'is_not_any_of'],
};

export function getOperatorsForType(type: QuestionType): Operator[] {
  return OPERATOR_MAP[type] ?? [];
}

export const OPERATOR_LABELS: Record<Operator, { sv: string; en: string }> = {
  equals: { sv: 'är lika med', en: 'equals' },
  not_equals: { sv: 'är inte lika med', en: 'not equals' },
  contains: { sv: 'innehåller', en: 'contains' },
  not_contains: { sv: 'innehåller inte', en: 'does not contain' },
  gt: { sv: 'större än', en: 'greater than' },
  lt: { sv: 'mindre än', en: 'less than' },
  gte: { sv: 'större eller lika med', en: 'greater or equal' },
  lte: { sv: 'mindre eller lika med', en: 'less or equal' },
  is_true: { sv: 'är Ja', en: 'is Yes' },
  is_false: { sv: 'är Nej', en: 'is No' },
  is_any_of: { sv: 'är någon av', en: 'is any of' },
  is_not_any_of: { sv: 'är inte någon av', en: 'is not any of' },
};

export const TYPE_LABELS: Record<QuestionType, { sv: string; en: string }> = {
  text: { sv: 'Text', en: 'Text' },
  boolean: { sv: 'Ja/Nej', en: 'Yes/No' },
  single_choice: { sv: 'Enkelval', en: 'Single choice' },
  multi_choice: { sv: 'Flerval', en: 'Multi choice' },
  number: { sv: 'Nummer', en: 'Number' },
  date: { sv: 'Datum', en: 'Date' },
};

// ── Rule Evaluation ─────────────────────────────────────────────────────────

function compareOrderedValues(
  answer: unknown,
  compareValue: unknown,
  predicate: (difference: number) => boolean,
): boolean {
  if (typeof answer === 'number' && typeof compareValue === 'number') {
    return predicate(answer - compareValue);
  }
  if (
    typeof answer === 'string'
    && typeof compareValue === 'string'
    && /^\d{4}-\d{2}-\d{2}$/.test(answer)
    && /^\d{4}-\d{2}-\d{2}$/.test(compareValue)
  ) {
    return predicate(answer.localeCompare(compareValue));
  }
  return false;
}

function checkOperator(operator: Operator, answer: unknown, compareValue: unknown): boolean {
  switch (operator) {
    case 'is_true':
      return answer === true || answer === 'true';
    case 'is_false':
      return answer === false || answer === 'false' || answer === null || answer === undefined;
    case 'equals':
      return JSON.stringify(answer) === JSON.stringify(compareValue);
    case 'not_equals':
      return JSON.stringify(answer) !== JSON.stringify(compareValue);
    case 'contains': {
      if (Array.isArray(answer)) return answer.includes(compareValue);
      if (typeof answer === 'string' && typeof compareValue === 'string')
        return answer.toLowerCase().includes(compareValue.toLowerCase());
      return false;
    }
    case 'not_contains': {
      if (Array.isArray(answer)) return !answer.includes(compareValue);
      if (typeof answer === 'string' && typeof compareValue === 'string')
        return !answer.toLowerCase().includes(compareValue.toLowerCase());
      return true;
    }
    case 'gt':
      return compareOrderedValues(answer, compareValue, (difference) => difference > 0);
    case 'lt':
      return compareOrderedValues(answer, compareValue, (difference) => difference < 0);
    case 'gte':
      return compareOrderedValues(answer, compareValue, (difference) => difference >= 0);
    case 'lte':
      return compareOrderedValues(answer, compareValue, (difference) => difference <= 0);
    case 'is_any_of': {
      if (!Array.isArray(compareValue)) return false;
      if (Array.isArray(answer)) return answer.some(v => compareValue.includes(v));
      return compareValue.includes(answer);
    }
    case 'is_not_any_of': {
      if (!Array.isArray(compareValue)) return true;
      if (Array.isArray(answer)) return !answer.some(v => compareValue.includes(v));
      return !compareValue.includes(answer);
    }
    default:
      return true;
  }
}

/**
 * Evaluate whether a question should be visible given rules and current answers.
 * Also checks parent visibility recursively.
 */
export function evaluateVisibility(
  questionId: string,
  rules: DisplayRule[],
  answers: AnswerMap,
  questions: TreeQuestion[],
  _visited?: Set<string>
): boolean {
  // Prevent infinite recursion
  const visited = _visited ?? new Set<string>();
  if (visited.has(questionId)) return false;
  visited.add(questionId);

  const question = questions.find(q => q.id === questionId);
  if (!question) return false;

  // Check parent visibility first
  if (question.parent_question_id) {
    if (!evaluateVisibility(question.parent_question_id, rules, answers, questions, visited)) {
      return false;
    }
  }

  // Get rules for this question
  const questionRules = rules.filter(r => r.question_id === questionId);
  if (questionRules.length === 0) return true; // No rules = always visible

  // Group by logic_group: AND within group, OR across groups
  const groups = new Map<number, DisplayRule[]>();
  for (const rule of questionRules) {
    if (!groups.has(rule.logic_group)) groups.set(rule.logic_group, []);
    groups.get(rule.logic_group)!.push(rule);
  }

  // OR across groups: at least one group must fully match
  for (const groupRules of groups.values()) {
    const allMatch = groupRules.every(rule => {
      const answer = answers[rule.depends_on_question_id];
      return checkOperator(rule.operator, answer, rule.compare_value);
    });
    if (allMatch) return true;
  }

  return false;
}

// ── Cycle Detection ─────────────────────────────────────────────────────────

/**
 * Detect cycles in display rules.
 * Build directed graph: depends_on → question_id, then DFS for back edges.
 */
export function hasCycle(rules: DisplayRule[]): boolean {
  // Build adjacency: if question A depends on question B, edge B → A
  // But for cycle detection in "visibility depends on", we care about:
  // question_id depends on depends_on_question_id
  // So edge: question_id → depends_on_question_id
  const adj = new Map<string, Set<string>>();
  for (const rule of rules) {
    if (!adj.has(rule.question_id)) adj.set(rule.question_id, new Set());
    adj.get(rule.question_id)!.add(rule.depends_on_question_id);
  }

  const WHITE = 0, GRAY = 1, BLACK = 2;
  const color = new Map<string, number>();

  const dfs = (node: string): boolean => {
    color.set(node, GRAY);
    const neighbors = adj.get(node);
    if (neighbors) {
      for (const neighbor of neighbors) {
        const c = color.get(neighbor) ?? WHITE;
        if (c === GRAY) return true; // back edge = cycle
        if (c === WHITE && dfs(neighbor)) return true;
      }
    }
    color.set(node, BLACK);
    return false;
  };

  for (const node of adj.keys()) {
    if ((color.get(node) ?? WHITE) === WHITE) {
      if (dfs(node)) return true;
    }
  }
  return false;
}

// ── Answer Parsing (lazy migration) ─────────────────────────────────────────

/**
 * Parse legacy answer_text into proper JSONB answer_value.
 */
export function parseAnswerText(text: string, questionType: QuestionType): unknown {
  if (!text && text !== '') return null;

  switch (questionType) {
    case 'boolean':
      return ['true', 'yes', 'ja'].includes(text.toLowerCase().trim());
    case 'number': {
      const n = Number(text.trim());
      return isNaN(n) ? text : n;
    }
    case 'multi_choice':
      try {
        const parsed = JSON.parse(text);
        if (Array.isArray(parsed)) return parsed;
      } catch { /* fall through */ }
      return text ? [text] : [];
    case 'single_choice':
    case 'date':
    case 'text':
    default:
      return text;
  }
}
