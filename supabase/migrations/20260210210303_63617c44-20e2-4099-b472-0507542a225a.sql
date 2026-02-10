
-- ============================================================
-- Migration: Dynamic Decision-Tree Questionnaire System
-- ============================================================

-- 1. Alter home_questions: add parent_question_id, order_index, type constraint
-- -------------------------------------------------------------------

-- Add parent_question_id (self-referencing FK)
ALTER TABLE public.home_questions
  ADD COLUMN parent_question_id uuid NULL
  REFERENCES public.home_questions(id) ON DELETE SET NULL;

-- Add order_index and populate from sort_order
ALTER TABLE public.home_questions
  ADD COLUMN order_index int NOT NULL DEFAULT 0;

UPDATE public.home_questions SET order_index = sort_order;

-- Create validation trigger for question_type (future-proof, not a CHECK)
CREATE OR REPLACE FUNCTION public.validate_question_type()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = 'public'
AS $$
BEGIN
  IF NEW.question_type NOT IN ('text', 'boolean', 'single_choice', 'multi_choice', 'number') THEN
    RAISE EXCEPTION 'Invalid question_type: %. Allowed: text, boolean, single_choice, multi_choice, number', NEW.question_type;
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER trg_validate_question_type
  BEFORE INSERT OR UPDATE ON public.home_questions
  FOR EACH ROW
  EXECUTE FUNCTION public.validate_question_type();

-- Index for tree queries
CREATE INDEX idx_home_questions_parent ON public.home_questions(parent_question_id);

-- 2. Create home_question_options
-- -------------------------------------------------------------------
CREATE TABLE public.home_question_options (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  question_id uuid NOT NULL REFERENCES public.home_questions(id) ON DELETE CASCADE,
  value text NOT NULL,
  label_sv text NOT NULL,
  label_en text NOT NULL DEFAULT '',
  order_index int NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (question_id, value)
);

ALTER TABLE public.home_question_options ENABLE ROW LEVEL SECURITY;

-- Staff full CRUD
CREATE POLICY "Staff can manage question options"
  ON public.home_question_options FOR ALL
  TO authenticated
  USING (public.is_staff(auth.uid()))
  WITH CHECK (public.is_staff(auth.uid()));

-- Anyone can read options for active contact-form questions
CREATE POLICY "Anyone can view contact form question options"
  ON public.home_question_options FOR SELECT
  TO anon, authenticated
  USING (
    EXISTS (
      SELECT 1 FROM public.home_questions hq
      WHERE hq.id = question_id
        AND hq.is_active = true
        AND hq.display_on_contact_form = true
    )
  );

-- Authenticated can read options for all active questions
CREATE POLICY "Authenticated can view active question options"
  ON public.home_question_options FOR SELECT
  TO authenticated
  USING (
    EXISTS (
      SELECT 1 FROM public.home_questions hq
      WHERE hq.id = question_id
        AND hq.is_active = true
    )
  );

-- 3. Create home_question_display_rules
-- -------------------------------------------------------------------
CREATE TABLE public.home_question_display_rules (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  question_id uuid NOT NULL REFERENCES public.home_questions(id) ON DELETE CASCADE,
  depends_on_question_id uuid NOT NULL REFERENCES public.home_questions(id) ON DELETE CASCADE,
  logic_group int NOT NULL DEFAULT 0,
  operator text NOT NULL CHECK (operator IN (
    'equals', 'not_equals', 'contains', 'not_contains',
    'gt', 'lt', 'gte', 'lte',
    'is_true', 'is_false',
    'is_any_of', 'is_not_any_of'
  )),
  compare_value jsonb,
  created_at timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE public.home_question_display_rules ENABLE ROW LEVEL SECURITY;

-- Staff full CRUD
CREATE POLICY "Staff can manage display rules"
  ON public.home_question_display_rules FOR ALL
  TO authenticated
  USING (public.is_staff(auth.uid()))
  WITH CHECK (public.is_staff(auth.uid()));

-- Anyone can read rules (needed for client-side evaluation)
CREATE POLICY "Anyone can view display rules"
  ON public.home_question_display_rules FOR SELECT
  TO anon, authenticated
  USING (true);

-- Indexes
CREATE INDEX idx_display_rules_question ON public.home_question_display_rules(question_id);
CREATE INDEX idx_display_rules_depends ON public.home_question_display_rules(depends_on_question_id);

-- 4. Add answer_value JSONB to home_answers and draft_answers
-- -------------------------------------------------------------------
ALTER TABLE public.home_answers
  ADD COLUMN answer_value jsonb NULL;

ALTER TABLE public.home_profile_draft_answers
  ADD COLUMN answer_value jsonb NULL;

-- 5. Backfill answer_value from existing answer_text
-- -------------------------------------------------------------------
UPDATE public.home_answers ha
SET answer_value = CASE
  WHEN hq.question_type = 'boolean' THEN
    CASE
      WHEN lower(trim(ha.answer_text)) IN ('true', 'yes', 'ja') THEN 'true'::jsonb
      WHEN lower(trim(ha.answer_text)) IN ('false', 'no', 'nej', '') THEN 'false'::jsonb
      ELSE to_jsonb(ha.answer_text)
    END
  WHEN hq.question_type = 'number' THEN
    CASE
      WHEN ha.answer_text ~ '^\s*-?\d+(\.\d+)?\s*$' THEN to_jsonb(trim(ha.answer_text)::numeric)
      ELSE to_jsonb(ha.answer_text)
    END
  ELSE
    to_jsonb(ha.answer_text)
END
FROM public.home_questions hq
WHERE ha.question_id = hq.id
  AND ha.answer_value IS NULL
  AND ha.answer_text IS NOT NULL
  AND ha.answer_text != '';

-- Also backfill drafts
UPDATE public.home_profile_draft_answers hda
SET answer_value = CASE
  WHEN hq.question_type = 'boolean' THEN
    CASE
      WHEN lower(trim(hda.answer_text)) IN ('true', 'yes', 'ja') THEN 'true'::jsonb
      WHEN lower(trim(hda.answer_text)) IN ('false', 'no', 'nej', '') THEN 'false'::jsonb
      ELSE to_jsonb(hda.answer_text)
    END
  ELSE
    to_jsonb(hda.answer_text)
END
FROM public.home_questions hq
WHERE hda.question_id = hq.id
  AND hda.answer_value IS NULL
  AND hda.answer_text IS NOT NULL
  AND hda.answer_text != '';
