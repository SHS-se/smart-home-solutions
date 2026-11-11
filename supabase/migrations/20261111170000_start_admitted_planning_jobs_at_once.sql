-- A job nobody has claimed yet is ready to solve at once. Its receipt used to
-- tell Home Assistant to wait a full second before the poll that starts the
-- solve, on every plan. A leased or retried job keeps its paced wait: there the
-- delay is the lease or the retry time, never less than a second.
CREATE OR REPLACE FUNCTION private.energy_planning_receipt(p_job private.energy_planning_jobs,p_include_plan boolean DEFAULT true)
RETURNS json LANGUAGE plpgsql STABLE SET search_path=public,private AS $$
DECLARE v_plan jsonb;
BEGIN
  IF p_job.state='published' THEN
    SELECT CASE WHEN p_include_plan THEN plan ELSE NULL END INTO v_plan FROM public.energy_optimisation_current
      WHERE home_id=p_job.home_id AND plan_id=p_job.plan_id AND snapshot_id=p_job.snapshot_id;
    IF FOUND THEN
      IF NOT p_include_plan THEN
        RETURN json_build_object('job_id',p_job.id,'state','published','pending',false,
          'snapshot_id',p_job.snapshot_id,'plan_id',p_job.plan_id,'source_hash',p_job.source_hash);
      END IF;
      RETURN json_build_object('job_id',p_job.id,'state','published','pending',false,
        'snapshot_id',p_job.snapshot_id,'plan_id',p_job.plan_id,'plan',v_plan,'source_hash',p_job.source_hash);
    END IF;
    RETURN json_build_object('job_id',p_job.id,'state','superseded','pending',false,
      'snapshot_id',p_job.snapshot_id,'source_hash',p_job.source_hash);
  ELSIF p_job.state='failed' THEN
    RETURN json_build_object('job_id',p_job.id,'state',p_job.state,'pending',false,
      'snapshot_id',p_job.snapshot_id,'code',p_job.code,'detail',p_job.detail,'source_hash',p_job.source_hash,
      'recapture',CASE WHEN p_job.code IN ('planner_upgraded','capture_horizon_ended','accepted_reference_changed') AND private.energy_planning_is_current(p_job)
        THEN json_build_object('replaces_job_id',p_job.id) ELSE NULL END);
  ELSIF p_job.state='pending' THEN
    RETURN json_build_object('job_id',p_job.id,'state',p_job.state,'pending',true,
      'snapshot_id',p_job.snapshot_id,'retry_after_ms',CASE WHEN p_job.fence=0 AND p_job.lease_until IS NULL AND p_job.code IS NULL
          AND p_job.wake_after<=clock_timestamp() THEN 100
        ELSE GREATEST(1000,CEIL(EXTRACT(EPOCH FROM
          (GREATEST(p_job.wake_after,COALESCE(p_job.lease_until,p_job.wake_after))-clock_timestamp()))*1000))::bigint END,
      'last_error',CASE WHEN p_job.code IS NOT NULL THEN json_build_object('code',p_job.code,'detail',p_job.detail) ELSE NULL END,
      'source_hash',p_job.source_hash);
  END IF;
  RETURN json_build_object('job_id',p_job.id,'state',p_job.state,'pending',false,
    'snapshot_id',p_job.snapshot_id,'source_hash',p_job.source_hash);
END; $$;
