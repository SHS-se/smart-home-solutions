-- Room history reads share the database with live planning. Admit one room
-- worker per home, including its capture, numerical cell and final recapture.
-- Keep this reservation separate from a job's publication lease: an input
-- change may fence a job while its old worker is still finishing database I/O.
ALTER TABLE private.energy_learning_jobs ADD COLUMN room_last_started_at timestamptz;
CREATE TABLE private.energy_room_learning_lanes (
 home_id uuid PRIMARY KEY REFERENCES public.homes(id) ON DELETE CASCADE,
 job_id uuid UNIQUE,
 generation bigint,
 fence bigint,
 lease_until timestamptz,
 CHECK ((job_id IS NULL AND generation IS NULL AND fence IS NULL AND lease_until IS NULL)
   OR (job_id IS NOT NULL AND generation IS NOT NULL AND fence IS NOT NULL AND lease_until IS NOT NULL))
);
ALTER TABLE private.energy_room_learning_lanes ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON private.energy_room_learning_lanes FROM PUBLIC,anon,authenticated,service_role;

-- An invocation started before this migration does not yet have a finally
-- release. Preserve its existing lease and let ordinary expiry recover it.
INSERT INTO private.energy_room_learning_lanes(home_id,job_id,generation,fence,lease_until)
 SELECT DISTINCT ON(home_id) home_id,id,generation,fence,lease_until
 FROM private.energy_learning_jobs WHERE owner_kind='room' AND lease_until>now()
 ORDER BY home_id,lease_until DESC,id;

CREATE FUNCTION private.next_energy_room_learning_job(p_home_id uuid) RETURNS uuid
LANGUAGE sql STABLE SET search_path=public,private AS $$
 SELECT j.id FROM private.energy_learning_jobs j
 WHERE j.home_id=p_home_id AND j.owner_kind='room' AND j.pending
   AND j.wake_after<=now() AND (j.lease_until IS NULL OR j.lease_until<=now())
   AND NOT EXISTS(SELECT FROM private.energy_room_learning_lanes lane
     WHERE lane.home_id=p_home_id AND lane.lease_until>now())
 ORDER BY j.room_last_started_at NULLS FIRST,j.id LIMIT 1;
$$;

CREATE OR REPLACE FUNCTION private.wake_energy_learning_job(p_id uuid) RETURNS void
LANGUAGE plpgsql SET search_path=public,private AS $$
DECLARE c private.energy_learning_credentials%ROWTYPE; owner record; target uuid:=p_id;
BEGIN
 SELECT home_id,owner_kind INTO owner FROM private.energy_learning_jobs WHERE id=p_id;
 IF NOT FOUND THEN RETURN; END IF;
 IF owner.owner_kind='room' THEN
   -- Notifications do not reserve capacity or lock a lane. In particular this
   -- function is also called while request/checkpoint holds a job row lock.
   target:=private.next_energy_room_learning_job(owner.home_id);
   IF target IS NULL THEN RETURN; END IF;
 END IF;
 SELECT * INTO STRICT c FROM private.energy_learning_credentials WHERE singleton;
 IF c.function_url IS NULL THEN RAISE EXCEPTION 'Learning endpoint is not configured'; END IF;
 PERFORM net.http_post(url:=c.function_url,
   headers:=jsonb_build_object('Content-Type','application/json','x-energy-learning-token',c.token),
   body:=jsonb_build_object('job_id',target),timeout_milliseconds:=30000);
END; $$;

CREATE OR REPLACE FUNCTION public.claim_energy_device_learning(p_job_id uuid) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,private AS $$
DECLARE j private.energy_learning_jobs%ROWTYPE; owner record;
 lane private.energy_room_learning_lanes%ROWTYPE; progress jsonb; revision bigint;
BEGIN
 SELECT home_id,owner_kind INTO owner FROM private.energy_learning_jobs WHERE id=p_job_id;
 IF NOT FOUND THEN RETURN NULL; END IF;
 IF owner.owner_kind='room' THEN
   INSERT INTO private.energy_room_learning_lanes(home_id) VALUES(owner.home_id) ON CONFLICT DO NOTHING;
   -- Claim locks lane then job. Release only locks the lane; ordinary request,
   -- publication and checkpoint never lock it, so there is no reverse order.
   SELECT * INTO lane FROM private.energy_room_learning_lanes
     WHERE home_id=owner.home_id FOR UPDATE SKIP LOCKED;
   IF NOT FOUND OR lane.lease_until>now() THEN RETURN NULL; END IF;
   IF private.next_energy_room_learning_job(owner.home_id) IS DISTINCT FROM p_job_id THEN
     PERFORM private.wake_energy_learning_job(p_job_id);
     RETURN NULL;
   END IF;
   SELECT * INTO j FROM private.energy_learning_jobs
     WHERE id=p_job_id AND home_id=owner.home_id AND owner_kind='room' AND pending
       AND wake_after<=now() AND (lease_until IS NULL OR lease_until<=now())
     FOR UPDATE SKIP LOCKED;
   IF NOT FOUND THEN RETURN NULL; END IF;
   UPDATE private.energy_learning_jobs SET fence=fence+1,lease_until=now()+interval '60 seconds',
     wake_after=now()+interval '60 seconds',attempts=attempts+1,room_last_started_at=now()
     WHERE id=p_job_id RETURNING * INTO j;
   UPDATE private.energy_room_learning_lanes SET job_id=j.id,generation=j.generation,
     fence=j.fence,lease_until=j.lease_until WHERE home_id=j.home_id;
   SELECT model_revision INTO revision FROM energy_optimisation_zone_models
     WHERE home_id=j.home_id AND room_key=j.owner_key FOR SHARE;
   DELETE FROM private.energy_room_fit_progress
     WHERE job_id=j.id AND (generation<>j.generation OR base_revision<>coalesce(revision,0));
   SELECT jsonb_build_object('metadata',p.metadata,'cells',p.cells,'cursor',jsonb_array_length(p.cells),
     'base_revision',p.base_revision) INTO progress FROM private.energy_room_fit_progress p WHERE p.job_id=j.id;
 ELSE
   -- Preserve the existing pool/device lease and retry behavior.
   UPDATE private.energy_learning_jobs SET fence=fence+1,lease_until=now()+interval '60 seconds',
     wake_after=now()+interval '60 seconds',attempts=attempts+1
   WHERE id=p_job_id AND owner_kind<>'room' AND pending AND (lease_until IS NULL OR lease_until<=now())
   RETURNING * INTO j;
   IF NOT FOUND THEN RETURN NULL; END IF;
 END IF;
 RETURN to_jsonb(j)||jsonb_build_object('room_fit_progress',progress);
END; $$;

-- The worker calls this in finally. Match the reservation token, not the
-- current job token: a revoked invocation may release its own old reservation
-- when it stops, but can never release a newer claimant's reservation.
CREATE FUNCTION public.release_energy_room_learning_lane(p_job_id uuid,p_generation bigint,p_fence bigint)
RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,private AS $$
DECLARE released_home uuid; next_job uuid;
BEGIN
 UPDATE private.energy_room_learning_lanes SET job_id=NULL,generation=NULL,fence=NULL,lease_until=NULL
 WHERE job_id=p_job_id AND generation=p_generation AND fence=p_fence RETURNING home_id INTO released_home;
 IF NOT FOUND THEN RETURN false; END IF;
 next_job:=private.next_energy_room_learning_job(released_home);
 IF next_job IS NOT NULL THEN PERFORM private.wake_energy_learning_job(next_job); END IF;
 RETURN true;
END; $$;

CREATE OR REPLACE FUNCTION private.sweep_energy_learning_jobs() RETURNS void
LANGUAGE plpgsql SET search_path=public,private AS $$
DECLARE candidate record;
BEGIN
 FOR candidate IN
   WITH room_homes AS (
     SELECT DISTINCT home_id FROM private.energy_learning_jobs
     WHERE owner_kind='room' AND pending AND wake_after<=now()
   ), room_heads AS MATERIALIZED (
     SELECT private.next_energy_room_learning_job(home_id) AS id FROM room_homes
   ), due AS (
     SELECT j.id,j.owner_kind,j.wake_after FROM room_heads h JOIN private.energy_learning_jobs j USING(id)
     UNION ALL
     SELECT id,owner_kind,wake_after FROM private.energy_learning_jobs
     WHERE owner_kind<>'room' AND pending AND wake_after<=now()
   ) SELECT * FROM due ORDER BY wake_after,id LIMIT 6
 LOOP
   IF candidate.owner_kind<>'room' THEN
     UPDATE private.energy_learning_jobs SET wake_after=now()+interval '10 seconds' WHERE id=candidate.id;
   END IF;
   -- Room wake_after is readiness, not a notification throttle. Moving it into
   -- the future here would cause the just-notified fair head to reject claim.
   PERFORM private.wake_energy_learning_job(candidate.id);
 END LOOP;
END; $$;

REVOKE ALL ON FUNCTION private.next_energy_room_learning_job(uuid) FROM PUBLIC,anon,authenticated,service_role;
REVOKE ALL ON FUNCTION public.release_energy_room_learning_lane(uuid,bigint,bigint) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.release_energy_room_learning_lane(uuid,bigint,bigint) TO service_role;
