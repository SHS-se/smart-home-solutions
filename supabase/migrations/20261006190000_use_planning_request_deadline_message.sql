-- The stored deadline owns expiry; avoid reporting an obsolete fixed duration
-- after the end-to-end target is revised.
CREATE OR REPLACE FUNCTION private.expire_energy_planning_job(p_job_id uuid)
RETURNS void LANGUAGE plpgsql SET search_path=public,private AS $$
DECLARE j private.energy_planning_jobs%ROWTYPE;
BEGIN
  j:=private.lock_energy_planning_job(p_job_id);
  IF j.id IS NULL OR j.state<>'pending' OR j.deadline_at>clock_timestamp() THEN RETURN; END IF;
  UPDATE private.energy_planning_jobs SET state='failed',fence=fence+1,lease_until=NULL,
    finished_at=clock_timestamp(),code='planning_deadline_exceeded',
    detail='Replanning exceeded its request deadline.' WHERE id=j.id RETURNING * INTO j;
  UPDATE public.energy_optimisation_current SET replan_error=j.detail
    WHERE home_id=j.home_id AND replan_request_id=(j.context->>'observed_replan_request_id')::uuid
    AND replan_request_id IS DISTINCT FROM replan_completed_request_id;
END; $$;
