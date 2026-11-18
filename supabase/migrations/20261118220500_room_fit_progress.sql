-- Derived, immutable learning input and numerical progress are private job
-- scratch, never measured history or an accepted thermal calibration.
CREATE TABLE private.energy_room_fit_progress (
 job_id uuid PRIMARY KEY REFERENCES private.energy_learning_jobs(id) ON DELETE CASCADE,
 generation bigint NOT NULL,
 base_revision bigint NOT NULL CHECK(base_revision>=0),
 metadata jsonb NOT NULL CHECK(jsonb_typeof(metadata)='object'),
 capture bytea NOT NULL CHECK(octet_length(capture)>0),
 cells jsonb NOT NULL DEFAULT '[]'::jsonb CHECK(jsonb_typeof(cells)='array' AND jsonb_array_length(cells)<=18)
);
ALTER TABLE private.energy_room_fit_progress ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON private.energy_room_fit_progress FROM PUBLIC,anon,authenticated,service_role;

CREATE FUNCTION private.clear_energy_room_fit_progress() RETURNS trigger
LANGUAGE plpgsql SET search_path=public,private AS $$
BEGIN
 IF NOT NEW.pending OR NEW.generation IS DISTINCT FROM OLD.generation
   OR NEW.input IS DISTINCT FROM OLD.input OR NEW.owner_kind IS DISTINCT FROM OLD.owner_kind
   OR NEW.owner_key IS DISTINCT FROM OLD.owner_key OR NEW.home_id IS DISTINCT FROM OLD.home_id
   OR NEW.customer_id IS DISTINCT FROM OLD.customer_id THEN
   DELETE FROM private.energy_room_fit_progress WHERE job_id=NEW.id;
 END IF;
 RETURN NEW;
END; $$;
CREATE TRIGGER clear_room_fit_progress AFTER UPDATE ON private.energy_learning_jobs
 FOR EACH ROW EXECUTE FUNCTION private.clear_energy_room_fit_progress();

-- Lock in the same order as publication: job, then the owner's calibration.
-- A model revision change invalidates only scratch. A false result never
-- modifies accepted coefficients and never lets a stale claimant write.
CREATE FUNCTION private.owns_energy_room_fit(p_job_id uuid,p_generation bigint,p_fence bigint,p_revision bigint)
RETURNS boolean LANGUAGE plpgsql SET search_path=public,private AS $$
DECLARE j private.energy_learning_jobs%ROWTYPE; revision bigint;
BEGIN
 SELECT * INTO j FROM private.energy_learning_jobs WHERE id=p_job_id FOR UPDATE;
 IF NOT FOUND OR j.owner_kind<>'room' OR NOT j.pending
   OR j.generation IS DISTINCT FROM p_generation OR j.fence IS DISTINCT FROM p_fence
   OR j.lease_until IS NULL OR j.lease_until<=now()
   OR NOT public.energy_home_matches_customer(j.home_id,j.customer_id) THEN RETURN false; END IF;
 SELECT model_revision INTO revision FROM energy_optimisation_zone_models
 WHERE home_id=j.home_id AND room_key=j.owner_key FOR SHARE;
 IF coalesce(revision,0) IS DISTINCT FROM p_revision THEN
   DELETE FROM private.energy_room_fit_progress WHERE job_id=j.id;
   RETURN false;
 END IF;
 RETURN true;
END; $$;

CREATE OR REPLACE FUNCTION public.claim_energy_device_learning(p_job_id uuid) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,private AS $$
DECLARE j private.energy_learning_jobs%ROWTYPE; progress jsonb; revision bigint;
BEGIN
 UPDATE private.energy_learning_jobs SET fence=fence+1,lease_until=now()+interval '60 seconds',
   wake_after=now()+interval '60 seconds',attempts=attempts+1
 WHERE id=p_job_id AND pending AND (lease_until IS NULL OR lease_until<=now()) RETURNING * INTO j;
 IF NOT FOUND THEN RETURN NULL; END IF;
 IF j.owner_kind='room' THEN
   SELECT model_revision INTO revision FROM energy_optimisation_zone_models
     WHERE home_id=j.home_id AND room_key=j.owner_key FOR SHARE;
   DELETE FROM private.energy_room_fit_progress
     WHERE job_id=j.id AND (generation<>j.generation OR base_revision<>coalesce(revision,0));
   SELECT jsonb_build_object('metadata',p.metadata,'cells',p.cells,'cursor',jsonb_array_length(p.cells),
     'base_revision',p.base_revision) INTO progress FROM private.energy_room_fit_progress p WHERE p.job_id=j.id;
 END IF;
 -- Do not join capture into a claim: it is downloaded only when the worker
 -- actually executes a numerical cell or finalization under this lease.
 RETURN to_jsonb(j)||jsonb_build_object('room_fit_progress',progress);
END; $$;

CREATE FUNCTION public.load_energy_room_fit_capture(p_job_id uuid,p_generation bigint,p_fence bigint,p_revision bigint)
RETURNS text LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,private AS $$
DECLARE capture_text text;
BEGIN
 IF NOT private.owns_energy_room_fit(p_job_id,p_generation,p_fence,p_revision) THEN RETURN NULL; END IF;
 SELECT replace(encode(capture,'base64'),E'\n','') INTO capture_text FROM private.energy_room_fit_progress
 WHERE job_id=p_job_id AND generation=p_generation AND base_revision=p_revision;
 RETURN capture_text;
END; $$;

CREATE FUNCTION private.resume_energy_room_fit(p_job_id uuid) RETURNS void
LANGUAGE plpgsql SET search_path=public,private AS $$
BEGIN
 UPDATE private.energy_learning_jobs SET lease_until=NULL,wake_after=now(),last_error=NULL,finished_at=NULL
 WHERE id=p_job_id;
 PERFORM private.wake_energy_learning_job(p_job_id);
END; $$;

-- -1 creates the immutable capture; 0..17 appends precisely one cell in the
-- caller's fixed (lag, training/full) order. Lost replies are recovered by the
-- next claim's authoritative prefix, never by replaying an unfenced write.
CREATE FUNCTION public.checkpoint_energy_room_fit(p_job_id uuid,p_generation bigint,p_fence bigint,p_revision bigint,
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
   UPDATE private.energy_room_fit_progress SET cells=cells||jsonb_build_array(p_cell)
   WHERE job_id=p_job_id AND generation=p_generation AND base_revision=p_revision
     AND jsonb_array_length(cells)=p_expected_cursor;
 END IF;
 IF NOT FOUND THEN RETURN false; END IF;
 PERFORM private.resume_energy_room_fit(p_job_id);
 RETURN true;
END; $$;

CREATE FUNCTION public.reset_energy_room_fit(p_job_id uuid,p_generation bigint,p_fence bigint,p_revision bigint,
 p_expected_cursor integer)
RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,private AS $$
DECLARE cursor integer;
BEGIN
 IF NOT private.owns_energy_room_fit(p_job_id,p_generation,p_fence,p_revision) THEN RETURN false; END IF;
 SELECT jsonb_array_length(cells) INTO cursor FROM private.energy_room_fit_progress WHERE job_id=p_job_id;
 IF coalesce(cursor,-1) IS DISTINCT FROM p_expected_cursor THEN RETURN false; END IF;
 DELETE FROM private.energy_room_fit_progress WHERE job_id=p_job_id;
 PERFORM private.resume_energy_room_fit(p_job_id);
 RETURN true;
END; $$;

CREATE FUNCTION public.complete_energy_room_fit(p_job_id uuid,p_generation bigint,p_fence bigint,p_revision bigint,
 p_expected_cursor integer,p_model jsonb)
RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,private AS $$
BEGIN
 IF NOT private.owns_energy_room_fit(p_job_id,p_generation,p_fence,p_revision) THEN RETURN false; END IF;
 IF p_expected_cursor IS DISTINCT FROM 18 OR NOT EXISTS(SELECT FROM private.energy_room_fit_progress
   WHERE job_id=p_job_id AND generation=p_generation AND base_revision=p_revision
     AND jsonb_array_length(cells)=p_expected_cursor) THEN RETURN false; END IF;
 -- The normal publisher retains all source, owner and calibration checks.
 -- Its terminal job update clears scratch via the trigger in this transaction.
 RETURN public.publish_energy_device_learning(p_job_id,p_generation,p_fence,p_revision,p_model);
END; $$;

REVOKE ALL ON FUNCTION private.clear_energy_room_fit_progress(),private.owns_energy_room_fit(uuid,bigint,bigint,bigint),
 private.resume_energy_room_fit(uuid) FROM PUBLIC,anon,authenticated,service_role;
REVOKE ALL ON FUNCTION public.load_energy_room_fit_capture(uuid,bigint,bigint,bigint),
 public.checkpoint_energy_room_fit(uuid,bigint,bigint,bigint,integer,jsonb,text,jsonb),
 public.reset_energy_room_fit(uuid,bigint,bigint,bigint,integer),
 public.complete_energy_room_fit(uuid,bigint,bigint,bigint,integer,jsonb) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.load_energy_room_fit_capture(uuid,bigint,bigint,bigint),
 public.checkpoint_energy_room_fit(uuid,bigint,bigint,bigint,integer,jsonb,text,jsonb),
 public.reset_energy_room_fit(uuid,bigint,bigint,bigint,integer),
 public.complete_energy_room_fit(uuid,bigint,bigint,bigint,integer,jsonb) TO service_role;
