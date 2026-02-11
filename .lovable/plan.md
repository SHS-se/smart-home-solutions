

## Add "Other (free text)" Option to Choice Questions

### Overview
Add a per-question toggle that appends an "Other" option with a free-text input field to single_choice and multi_choice questions. This lets respondents provide an answer not covered by the predefined options.

### How It Works
- A new toggle "Allow Other" appears in the question admin row (next to the question type badge) for single/multi choice questions
- When enabled, the end-user form automatically appends an "Other" radio/checkbox with a text input
- The answer is stored as `"__other:Their typed text"` so it's distinguishable from predefined options

### Changes

**1. Database: Add `allow_other` column to `home_questions`**
- Add a boolean column `allow_other` (default `false`) to the `home_questions` table
- Only relevant for `single_choice` and `multi_choice` types

**2. Admin UI: QuestionnaireManager**
- Add a small toggle or checkbox labeled "Annat/Other" in the question row, visible only for single/multi choice question types
- Toggling it updates the `allow_other` column on the question

**3. End-User Form: HomeProfileForm**
- For `single_choice`: append an "Other" radio option; when selected, show a text input. Store value as `"__other:text"`
- For `multi_choice`: append an "Other" checkbox; when checked, show a text input. Include `"__other:text"` in the array
- Parse `__other:` prefix when loading existing answers to restore the text field state

**4. Preview: QuestionnairePreview**
- Mirror the same "Other" rendering logic so the admin preview matches the real form

### Technical Details

- **Migration SQL**: `ALTER TABLE public.home_questions ADD COLUMN allow_other boolean NOT NULL DEFAULT false;`
- **Answer format**: The special value prefix `__other:` is used to store free-text answers (e.g., `"__other:Pellets"` for single choice, or `["direct_electric", "__other:Pellets"]` for multi choice)
- **Files modified**:
  - `supabase/migrations/` -- new migration for the column
  - `src/pages/portal/settings/QuestionnaireManager.tsx` -- add toggle in question row
  - `src/components/portal/home-profile/HomeProfileForm.tsx` -- render "Other" option + text input
  - `src/components/portal/settings/QuestionnairePreview.tsx` -- same rendering in preview
- **No changes needed** to RLS policies (column inherits existing row-level policies)
