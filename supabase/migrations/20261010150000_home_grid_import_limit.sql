-- The planner's grid import limit belongs to the home profile: the main fuse
-- sets the most a home can draw, and its owner may choose to draw less. It was
-- read from a setting in the Home Assistant app, which automatic setup filled
-- from the inverter's power rating rather than the fuse.
INSERT INTO public.home_questions (
  id, parent_question_id, question_text, question_text_en, question_type,
  semantic_key, sort_order, order_index, is_active, display_on_contact_form, allow_other
)
SELECT
  '6d159c2f-31a1-4dd3-9f93-000000000017', fuse.id,
  'Hur mycket effekt får bostaden högst ta från elnätet? (kW)',
  'What is the most power the home may draw from the grid? (kW)',
  'number', 'grid_import_limit_kw', 0, 0, true, false, false
FROM public.home_questions fuse
WHERE fuse.semantic_key = 'main_fuse_a'
  AND NOT EXISTS (SELECT 1 FROM public.home_questions WHERE semantic_key = 'grid_import_limit_kw');

-- Shown once a fuse is chosen, as the battery's size is once a battery is.
INSERT INTO public.home_question_display_rules (question_id, depends_on_question_id, logic_group, operator, compare_value)
SELECT question.id, question.parent_question_id, 0, 'is_any_of', '["16","20","25","35","50","63"]'::jsonb
FROM public.home_questions question
WHERE question.semantic_key = 'grid_import_limit_kw'
  AND NOT EXISTS (SELECT 1 FROM public.home_question_display_rules WHERE question_id = question.id);
