-- Runtime admission, not publication or cache validation, resolves a handover.
CREATE OR REPLACE FUNCTION public.report_energy_runtime(p_home_id uuid, p_runtime jsonb)
RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  current_row public.energy_optimisation_current%ROWTYPE;
  reference jsonb;
  admitted jsonb := p_runtime->'battery_plan'->'accepted';
  rejected jsonb := p_runtime->'battery_plan'->'rejection';
  recommendations jsonb;
BEGIN
  SELECT * INTO current_row FROM public.energy_optimisation_current WHERE home_id=p_home_id FOR UPDATE;
  IF NOT FOUND OR (current_row.ha_runtime IS NOT NULL AND
    (current_row.ha_runtime->>'observed_at')::timestamptz >= (p_runtime->>'observed_at')::timestamptz) THEN
    RETURN false;
  END IF;
  reference := current_row.plan_jsonb->'battery_execution';
  recommendations := current_row.replan_recommendations;
  IF current_row.status='ready' AND admitted->>'plan_id'=current_row.plan_id::text
    AND admitted->>'contract_id'=reference->>'id'
    AND admitted->>'scope_revision'=reference->>'scope_revision'
    AND admitted->>'generation'=reference->>'generation' THEN
    SELECT coalesce(jsonb_agg(r),'[]'::jsonb) INTO recommendations
      FROM jsonb_array_elements(recommendations) r
      WHERE NOT coalesce((r->>'key'='battery_plan_handover'
        AND r->>'scope_revision'=admitted->>'scope_revision'
        AND (r->>'generation')::bigint <= (admitted->>'generation')::bigint),false);
  ELSIF current_row.status='ready' AND rejected->>'contract_id'=reference->>'id'
    AND rejected->>'generation'=reference->>'generation'
    AND NOT coalesce(
      current_row.ha_runtime->'battery_plan'->'accepted'->>'plan_id'=current_row.plan_id::text
      AND current_row.ha_runtime->'battery_plan'->'accepted'->>'contract_id'=reference->>'id', false) THEN
    -- Obsolete contracts never create recommendations for a newer publication.
    SELECT coalesce(jsonb_agg(r),'[]'::jsonb) INTO recommendations
      FROM jsonb_array_elements(recommendations) r
      WHERE NOT coalesce((r->>'key'='battery_plan_handover'
        AND r->>'scope_revision'=reference->>'scope_revision'
        AND (r->>'generation')::bigint <= (rejected->>'generation')::bigint),false);
    recommendations := recommendations || jsonb_build_array(jsonb_build_object(
      'key','battery_plan_handover', 'scope_revision',reference->>'scope_revision',
      'generation',(reference->>'generation')::bigint,
      'reason','Battery controller could not accept the replacement plan: ' || (rejected->>'reason'),
      'occurred_at',clock_timestamp()));
  END IF;
  UPDATE public.energy_optimisation_current
    SET ha_runtime=p_runtime, ha_runtime_received_at=clock_timestamp(), replan_recommendations=recommendations
    WHERE home_id=p_home_id;
  RETURN true;
END; $$;

CREATE OR REPLACE FUNCTION public.clear_solved_energy_recommendations() RETURNS trigger
LANGUAGE plpgsql SET search_path = public AS $$
BEGIN
  SELECT coalesce(jsonb_agg(r),'[]'::jsonb) INTO NEW.replan_recommendations
    FROM jsonb_array_elements(OLD.replan_recommendations) r
    WHERE r->>'key'='battery_plan_handover' OR (r->>'occurred_at')::timestamptz > NEW.issued_at;
  RETURN NEW;
END; $$;

-- Classify the exact historical handover notice once. Other integration-change
-- recommendations retain their identity and require their own resolution.
UPDATE public.energy_optimisation_current c
SET replan_recommendations=(SELECT coalesce(jsonb_agg(
  CASE WHEN r->>'key'='integration_change' AND
    r->>'reason'='Battery controller: plan_handover_rejected. Consider a manual replan.'
  THEN r || jsonb_build_object('key','battery_plan_handover',
    'scope_revision',c.plan_jsonb->'battery_execution'->>'scope_revision',
    'generation',(c.plan_jsonb->'battery_execution'->>'generation')::bigint)
  ELSE r END),'[]'::jsonb) FROM jsonb_array_elements(c.replan_recommendations) r)
WHERE c.plan_jsonb->'battery_execution'->>'scope_revision' IS NOT NULL
  AND c.plan_jsonb->'battery_execution'->>'generation' IS NOT NULL
  AND c.replan_recommendations @> '[{"key":"integration_change","reason":"Battery controller: plan_handover_rejected. Consider a manual replan."}]'::jsonb;
