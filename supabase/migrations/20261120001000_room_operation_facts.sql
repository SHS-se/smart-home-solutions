-- Reviewed operating direction is knowledge about a dated physical-source
-- epoch. It is not an observed compressor state or a rewritten mode flag.
CREATE TABLE private.energy_room_operation_facts (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
 home_id uuid NOT NULL REFERENCES public.homes(id) ON DELETE CASCADE,
 customer_id uuid NOT NULL REFERENCES public.customers(id) ON DELETE CASCADE,
 room_key text NOT NULL CHECK(length(room_key)>0),
 binding text NOT NULL CHECK(length(binding)>0),
 kind text NOT NULL DEFAULT 'heating_off_fan' CHECK(kind='heating_off_fan'),
 from_at timestamptz NOT NULL,
 to_at timestamptz NOT NULL,
 basis text NOT NULL CHECK(basis IN ('customer_assertion','source_capability')),
 created_at timestamptz NOT NULL DEFAULT statement_timestamp(),
 CHECK(isfinite(from_at) AND isfinite(to_at) AND to_at>from_at),
 CHECK(public.energy_home_matches_customer(home_id,customer_id))
);
CREATE INDEX energy_room_operation_facts_source ON private.energy_room_operation_facts(home_id,room_key,binding,from_at,to_at);
ALTER TABLE private.energy_room_operation_facts ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON private.energy_room_operation_facts FROM PUBLIC,anon,authenticated,service_role;

CREATE FUNCTION public.get_energy_room_operation_facts(
 p_home_id uuid,p_customer_id uuid,p_room_key text,p_from timestamptz,p_to timestamptz)
RETURNS TABLE(id uuid,kind text,from_at timestamptz,to_at timestamptz,basis text,binding text,created_at timestamptz)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=public,private AS $$
BEGIN
 IF NOT coalesce(public.energy_home_matches_customer(p_home_id,p_customer_id),false) THEN
   RAISE EXCEPTION 'Home mismatch';
 END IF;
 RETURN QUERY SELECT f.id,f.kind,f.from_at,f.to_at,f.basis,f.binding,f.created_at
 FROM private.energy_room_operation_facts f
 JOIN private.energy_room_heating_contexts(p_home_id,true) c
   ON c.room_key=f.room_key AND c.binding=f.binding
 WHERE f.home_id=p_home_id AND f.customer_id=p_customer_id AND f.room_key=p_room_key
   AND f.from_at<p_to AND f.to_at>p_from
 ORDER BY f.from_at,f.id;
END; $$;
REVOKE ALL ON FUNCTION public.get_energy_room_operation_facts(uuid,uuid,text,timestamptz,timestamptz)
 FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.get_energy_room_operation_facts(uuid,uuid,text,timestamptz,timestamptz) TO service_role;

CREATE FUNCTION private.keep_room_operation_fact_identity() RETURNS trigger
LANGUAGE plpgsql SET search_path=public,private AS $$
BEGIN
 IF NEW IS DISTINCT FROM OLD THEN
   RAISE EXCEPTION 'Replace an operation fact by deleting and inserting its reviewed identity';
 END IF;
 RETURN NEW;
END; $$;
CREATE TRIGGER keep_room_operation_fact_identity BEFORE UPDATE ON private.energy_room_operation_facts
 FOR EACH ROW EXECUTE FUNCTION private.keep_room_operation_fact_identity();

CREATE FUNCTION private.review_room_operation_fact() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,private AS $$
DECLARE fact private.energy_room_operation_facts%ROWTYPE; job_id uuid;
BEGIN
 fact:=CASE WHEN TG_OP='DELETE' THEN OLD ELSE NEW END;
 -- Retired bindings remain auditable but cannot change a different plant.
 IF NOT EXISTS(SELECT FROM public.homes WHERE id=fact.home_id) OR
   NOT EXISTS(SELECT FROM private.energy_room_heating_contexts(fact.home_id) c
   WHERE c.room_key=fact.room_key AND c.binding=fact.binding) THEN
   RETURN CASE WHEN TG_OP='DELETE' THEN OLD ELSE NEW END;
 END IF;
 -- Publication also locks the job before its model. Fence the old numerical
 -- capture before invalidating attempt bookkeeping; keep accepted bands.
 INSERT INTO private.energy_learning_jobs(home_id,customer_id,owner_kind,owner_key,input)
 VALUES(fact.home_id,fact.customer_id,'room',fact.room_key,'{}'::jsonb)
 ON CONFLICT(home_id,owner_kind,owner_key) DO UPDATE SET
   pending=true,generation=energy_learning_jobs.generation+1,fence=energy_learning_jobs.fence+1,
   lease_until=NULL,wake_after=now(),attempts=0,last_error=NULL,finished_at=NULL
 RETURNING id INTO job_id;
 UPDATE public.energy_optimisation_zone_models m SET
   heating_bands=CASE WHEN m.heating_bands IS NULL THEN NULL ELSE
     (m.heating_bands-ARRAY['window_attempts','general_attempt'])||jsonb_build_object('pending_windows',1) END,
   last_attempted_at=NULL
 WHERE m.home_id=fact.home_id AND m.room_key=fact.room_key;
 -- The ordinary model-revision trigger advances the publication fence too.
 PERFORM private.wake_energy_learning_job(job_id);
 RETURN CASE WHEN TG_OP='DELETE' THEN OLD ELSE NEW END;
END; $$;
CREATE TRIGGER review_room_operation_fact AFTER INSERT OR DELETE ON private.energy_room_operation_facts
 FOR EACH ROW EXECUTE FUNCTION private.review_room_operation_fact();
REVOKE ALL ON FUNCTION private.keep_room_operation_fact_identity(),private.review_room_operation_fact()
 FROM PUBLIC,anon,authenticated,service_role;
