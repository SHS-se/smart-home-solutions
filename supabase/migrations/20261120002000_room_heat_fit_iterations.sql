-- Bounded additional-heat fitting uses the existing fenced room lifecycle.
CREATE OR REPLACE FUNCTION public.checkpoint_energy_room_fit(p_job_id uuid,p_generation bigint,p_fence bigint,p_revision bigint,
 p_expected_cursor integer,p_metadata jsonb,p_capture_base64 text,p_cell jsonb)
RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,private AS $$
BEGIN
 IF NOT private.owns_energy_room_fit(p_job_id,p_generation,p_fence,p_revision) THEN RETURN false; END IF;
 IF p_expected_cursor=-1 THEN
   IF jsonb_typeof(p_metadata) IS DISTINCT FROM 'object' OR p_capture_base64 IS NULL
     OR p_cell IS NOT NULL THEN RAISE EXCEPTION 'Invalid initial room fit capture'; END IF;
   INSERT INTO private.energy_room_fit_progress(job_id,generation,base_revision,metadata,capture)
   VALUES(p_job_id,p_generation,p_revision,p_metadata,decode(p_capture_base64,'base64'))
   ON CONFLICT(job_id) DO NOTHING;
 ELSE
   IF p_expected_cursor IS NULL OR p_expected_cursor<0 OR p_expected_cursor>=18
     OR p_metadata IS NOT NULL OR p_capture_base64 IS NOT NULL
     OR jsonb_typeof(p_cell) IS DISTINCT FROM 'object' THEN RAISE EXCEPTION 'Invalid room fit cell'; END IF;
   UPDATE private.energy_room_fit_progress SET cells=cells||jsonb_build_array(p_cell),metadata=metadata-'heat_state'
   WHERE job_id=p_job_id AND generation=p_generation AND base_revision=p_revision
     AND jsonb_array_length(cells)=p_expected_cursor;
 END IF;
 IF NOT FOUND THEN RETURN false; END IF;
 PERFORM private.resume_energy_room_fit(p_job_id);
 RETURN true;
END; $$;

-- A numerical iteration retains the immutable capture and completed cell
-- prefix. Compare its old state as well as its cursor and owner fence, so a
-- lost reply cannot apply the same ECM iteration twice.
CREATE FUNCTION public.checkpoint_energy_room_heat_iteration(
 p_job_id uuid,p_generation bigint,p_fence bigint,p_revision bigint,
 p_expected_cursor integer,p_expected_state jsonb,p_heat_state jsonb)
RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,private AS $$
BEGIN
 IF NOT private.owns_energy_room_fit(p_job_id,p_generation,p_fence,p_revision) THEN RETURN false; END IF;
 IF p_expected_cursor IS NULL OR p_expected_cursor<0 OR p_expected_cursor>=18
   OR jsonb_typeof(p_heat_state) IS DISTINCT FROM 'object'
   OR p_heat_state->>'version' IS DISTINCT FROM '2'
   OR (p_heat_state->>'index')::integer IS DISTINCT FROM p_expected_cursor THEN
   RAISE EXCEPTION 'Invalid additional heat iteration';
 END IF;
 UPDATE private.energy_room_fit_progress SET metadata=jsonb_set(metadata,'{heat_state}',p_heat_state)
 WHERE job_id=p_job_id AND generation=p_generation AND base_revision=p_revision
   AND jsonb_array_length(cells)=p_expected_cursor
   AND nullif(metadata->'heat_state','null'::jsonb) IS NOT DISTINCT FROM nullif(p_expected_state,'null'::jsonb);
 IF NOT FOUND THEN RETURN false; END IF;
 PERFORM private.resume_energy_room_fit(p_job_id);
 RETURN true;
END; $$;
REVOKE ALL ON FUNCTION public.checkpoint_energy_room_heat_iteration(uuid,bigint,bigint,bigint,integer,jsonb,jsonb)
 FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.checkpoint_energy_room_heat_iteration(uuid,bigint,bigint,bigint,integer,jsonb,jsonb)
 TO service_role;
