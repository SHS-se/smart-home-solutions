

# Dynamic Decision-Tree Questionnaire System

## Overview

Refactor the flat home questions system into a dynamic decision-tree with conditional visibility, multiple-choice types, JSONB answers, and a tree-based admin UI.

## 1. Database Migrations

### Migration 1: Alter `home_questions`

- Add `parent_question_id uuid NULL` with self-referencing FK to `home_questions.id` (ON DELETE SET NULL)
- Rename `sort_order` to `order_index` (or add `order_index` and migrate values, then drop `sort_order` later)
- Add CHECK constraint on `question_type` for allowed values: `text`, `boolean`, `single_choice`, `multi_choice`, `number`

### Migration 2: Create `home_question_options`

```text
id              uuid PK default gen_random_uuid()
question_id     uuid FK -> home_questions.id ON DELETE CASCADE
value           text NOT NULL
label_sv        text NOT NULL
label_en        text NOT NULL default ''
order_index     int NOT NULL default 0
created_at      timestamptz default now()

UNIQUE (question_id, value)
```

RLS:
- Staff: full CRUD (via `is_staff()`)
- Anon + authenticated: SELECT where question is active + on contact form (join through question)
- Authenticated: SELECT where question is active

### Migration 3: Create `home_question_display_rules`

```text
id                       uuid PK default gen_random_uuid()
question_id              uuid FK -> home_questions.id ON DELETE CASCADE
depends_on_question_id   uuid FK -> home_questions.id ON DELETE CASCADE
logic_group              int NOT NULL default 0
operator                 text NOT NULL CHECK (in: 'equals', 'not_equals', 'contains', 'not_contains', 'gt', 'lt', 'gte', 'lte', 'is_true', 'is_false', 'is_any_of', 'is_not_any_of')
compare_value            jsonb
created_at               timestamptz default now()
```

RLS:
- Staff: full CRUD
- Anon + authenticated: SELECT (needed for client-side rule evaluation on contact form)
- Authenticated: SELECT (for home profile)

### Migration 4: Add `answer_value` to `home_answers`

```sql
ALTER TABLE home_answers ADD COLUMN answer_value jsonb NULL;
```

Non-breaking -- `answer_text` remains.

### Migration 5: Backfill `answer_value`

A one-time SQL migration that joins `home_answers` with `home_questions` and populates `answer_value`:

- `boolean` type: `'true'` or `'yes'` -> `true`, else `false`
- `number` type: attempt `answer_text::numeric`, wrap as JSON number
- `text` type: wrap as JSON string
- Others: wrap as JSON string

Also add `answer_value` to `home_profile_draft_answers` for future use.

## 2. Shared Rule Engine Utility

Create `src/lib/questionnaire-engine.ts` with:

- **`flattenTree(questions)`**: Takes questions with `parent_question_id` and `order_index`, returns depth-first ordered flat list with `depth` metadata
- **`evaluateVisibility(questionId, rules, answers, questions)`**: Returns boolean. Evaluates display rules against current `answer_value` map. AND within same `logic_group`, OR across groups. Also checks parent visibility recursively.
- **`hasCycle(rules, questions)`**: Detects circular dependencies in rules graph (used by admin UI for validation before save)
- **`getOperatorsForType(questionType)`**: Returns valid operators for a given question type

## 3. Admin UI: Tree Questionnaire Manager

Rewrite `QuestionnaireManager.tsx`:

- **Tree view** with indentation based on `parent_question_id` depth
- **Drag-and-drop** reordering within same parent (updates `order_index`)
- **Indent/outdent** buttons to change `parent_question_id`
- **Collapsible** parent nodes
- **Badges** on each row: type badge, Active toggle, Contact form toggle, rule count indicator
- **Inline editing** of question text (sv/en) and type (existing pattern preserved)

### Options Editor (inline expandable)

For `single_choice` / `multi_choice` questions:
- Shows list of options with value, label_sv, label_en, order
- Add/remove/reorder options
- Enforces unique `value` per question

### Conditions Editor (inline expandable)

- Toggle: "Always shown" vs "Shown when..."
- Rule builder rows: pick depends_on_question, operator (filtered by type), value input (typed: boolean switch, text input, option picker, number input)
- Support multiple rules grouped by `logic_group` (AND within group, OR across groups)
- Cycle prevention check before save

### Preview Mode

- Button to open a simulation panel
- Renders the questionnaire tree as the customer would see it
- Allows answering to test conditional visibility in real-time

## 4. Runtime UI Updates

### HomeProfileForm.tsx

- Fetch questions, options, rules, and answers in parallel
- Use `flattenTree()` to order questions
- Use `evaluateVisibility()` to show/hide questions reactively as answers change
- Render by type:
  - `text`: Textarea (existing)
  - `boolean`: Switch with Ja/Nej (existing)
  - `single_choice`: Radio group or Select from options
  - `multi_choice`: Checkbox group from options
  - `number`: Number input
- Read/write `answer_value` (JSONB). Lazy migration: if `answer_value` is null, parse `answer_text` once and write back.
- When a question becomes hidden, clear its `answer_value`
- Indented rendering for child questions

### Contact.tsx

- Also fetch options and rules for contact-form questions
- Apply same visibility logic
- Render choice types with appropriate inputs
- Submit `answer_value` (as JSON) in draft_answers payload

## 5. Edge Function Updates

### `send-contact-email/index.ts`

- Accept `answer_value` (jsonb) alongside `answer_text` in draft_answers payload
- Store in `home_profile_draft_answers.answer_value`

### `migrate-draft-profile/index.ts`

- Copy `answer_value` from drafts to `home_answers.answer_value` during migration

## 6. Files to Create/Modify

### New Files
- `src/lib/questionnaire-engine.ts` -- shared rule engine
- `src/components/portal/settings/OptionsEditor.tsx` -- options inline editor
- `src/components/portal/settings/ConditionsEditor.tsx` -- rules inline editor
- `src/components/portal/settings/QuestionnairePreview.tsx` -- preview simulation

### Modified Files
- `src/pages/portal/settings/QuestionnaireManager.tsx` -- full rewrite to tree UI
- `src/components/portal/home-profile/HomeProfileForm.tsx` -- new types + rule evaluation
- `src/pages/Contact.tsx` -- new types + rule evaluation
- `supabase/functions/send-contact-email/index.ts` -- accept answer_value
- `supabase/functions/migrate-draft-profile/index.ts` -- copy answer_value

## 7. Implementation Order

1. Database migrations (5 migrations in sequence)
2. Rule engine utility (`questionnaire-engine.ts`)
3. Admin UI (QuestionnaireManager rewrite + Options/Conditions editors + Preview)
4. Runtime UI (HomeProfileForm + Contact form)
5. Edge function updates
6. End-to-end testing

## 8. Safety Considerations

- `answer_text` column is preserved indefinitely -- no data loss
- Backfill migration handles edge cases (empty strings, malformed data)
- Existing boolean answers stored as `'true'`/`'yes'`/`'false'` are normalized
- CHECK constraint on `question_type` uses a validation trigger (not a CHECK for future-proofing)
- `operator` uses a CHECK constraint (safe since it's immutable list)
- Foreign keys with ON DELETE CASCADE on options and rules prevent orphaned data
- Cycle detection prevents infinite loops in rule evaluation

