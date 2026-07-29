-- The existing "heated area" binding points to the heated boarea question.
-- Keep the two source areas distinct and derive estimated Atemp in application code.
UPDATE public.home_questions
SET semantic_key = 'heated_boarea_m2'
WHERE semantic_key = 'heated_area_m2';

UPDATE public.home_questions
SET semantic_key = 'heated_biarea_m2'
WHERE question_text_en = 'How many square meters of heated biarea are in your home?';
