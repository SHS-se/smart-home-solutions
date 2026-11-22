-- One fenced commit records every cell a worker completed within its bounded
-- numerical budget, plus the next cell's partial additional-heat state. The
-- capture, metadata envelope (version 2), heat_state (version 2) and cell
-- encoding are unchanged, so staged work resumes and retention still holds
-- its inputs. Only the number of commits per band changes.
CREATE FUNCTION public.checkpoint_energy_room_fit_cells(
 p_job_id uuid,p_generation bigint,p_fence bigint,p_revision bigint,
 p_expected_cursor integer,p_expected_state jsonb,p_cells jsonb,p_heat_state jsonb)
RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,private AS $$
DECLARE added integer; next_cursor integer;
BEGIN
 p_expected_state:=nullif(p_expected_state,'null'::jsonb);
 p_heat_state:=nullif(p_heat_state,'null'::jsonb);
 IF NOT private.owns_energy_room_fit(p_job_id,p_generation,p_fence,p_revision) THEN RETURN false; END IF;
 IF jsonb_typeof(p_cells) IS DISTINCT FROM 'array' THEN RAISE EXCEPTION 'Invalid room fit cells'; END IF;
 added:=jsonb_array_length(p_cells);
 next_cursor:=p_expected_cursor+added;
 IF p_expected_cursor IS NULL OR p_expected_cursor<0 OR next_cursor>36
   OR (added=0 AND p_heat_state IS NULL)
   OR EXISTS(SELECT FROM jsonb_array_elements(p_cells) cell WHERE jsonb_typeof(cell)<>'object') THEN
   RAISE EXCEPTION 'Invalid room fit cells';
 END IF;
 IF p_heat_state IS NOT NULL AND (next_cursor>=36 OR jsonb_typeof(p_heat_state)<>'object'
   OR p_heat_state->>'version' IS DISTINCT FROM '2'
   OR (p_heat_state->>'index')::integer IS DISTINCT FROM mod(next_cursor,18)) THEN
   RAISE EXCEPTION 'Invalid room response iteration';
 END IF;
 -- Compare the authoritative prefix and partial state the batch started from.
 -- A lost reply or stale claimant can therefore never append cells twice or
 -- apply an iteration twice.
 UPDATE private.energy_room_fit_progress SET cells=cells||p_cells,
   metadata=CASE WHEN p_heat_state IS NULL THEN metadata-'heat_state'
     ELSE jsonb_set(metadata,'{heat_state}',p_heat_state) END
 WHERE job_id=p_job_id AND generation=p_generation AND base_revision=p_revision
   AND jsonb_array_length(cells)=p_expected_cursor
   AND nullif(metadata->'heat_state','null'::jsonb) IS NOT DISTINCT FROM p_expected_state;
 IF NOT FOUND THEN RETURN false; END IF;
 PERFORM private.resume_energy_room_fit(p_job_id);
 RETURN true;
END; $$;
REVOKE ALL ON FUNCTION public.checkpoint_energy_room_fit_cells(uuid,bigint,bigint,bigint,integer,jsonb,jsonb,jsonb)
 FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.checkpoint_energy_room_fit_cells(uuid,bigint,bigint,bigint,integer,jsonb,jsonb,jsonb)
 TO service_role;
