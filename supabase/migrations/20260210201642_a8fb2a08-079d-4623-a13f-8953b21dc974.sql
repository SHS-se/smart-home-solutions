
-- Drop the overly broad authenticated-only policy
DROP POLICY "Authenticated users can view questions" ON public.home_questions;

-- Anon + authenticated can see contact-form questions
CREATE POLICY "Anyone can view contact form questions"
  ON public.home_questions FOR SELECT
  TO anon, authenticated
  USING (is_active = true AND display_on_contact_form = true);

-- Authenticated users can also see all active questions (for Home Profile)
CREATE POLICY "Authenticated users can view active questions"
  ON public.home_questions FOR SELECT
  TO authenticated
  USING (is_active = true);
