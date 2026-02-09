
-- 1) New table for draft answers before verification
CREATE TABLE public.home_profile_draft_answers (
  id uuid NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  email text NOT NULL,
  question_id uuid NOT NULL REFERENCES public.home_questions(id) ON DELETE CASCADE,
  answer_text text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(email, question_id)
);

-- RLS: no public access, staff can SELECT
ALTER TABLE public.home_profile_draft_answers ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Staff can view draft answers"
  ON public.home_profile_draft_answers
  FOR SELECT
  USING (public.is_staff(auth.uid()));

-- 2) Add question_type and display_on_contact_form to home_questions
ALTER TABLE public.home_questions
  ADD COLUMN question_type text NOT NULL DEFAULT 'text',
  ADD COLUMN display_on_contact_form boolean NOT NULL DEFAULT false;
