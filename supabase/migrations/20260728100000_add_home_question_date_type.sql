-- Add an ISO date answer type to the configurable home-profile questionnaire.
CREATE OR REPLACE FUNCTION public.validate_question_type()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = 'public'
AS $$
BEGIN
  IF NEW.question_type NOT IN (
    'text',
    'boolean',
    'single_choice',
    'multi_choice',
    'number',
    'date'
  ) THEN
    RAISE EXCEPTION
      'Invalid question_type: %. Allowed: text, boolean, single_choice, multi_choice, number, date',
      NEW.question_type;
  END IF;
  RETURN NEW;
END;
$$;

COMMENT ON COLUMN public.home_questions.semantic_key IS
  'Optional unique binding to a supported website function. Managed through the staff questionnaire editor.';
