-- Scheduling provenance is independent of disposable numerical scratch and of
-- accepted calibrations. A superseded capture has still received its fair turn.
ALTER TABLE private.energy_learning_jobs ADD COLUMN room_window_visits jsonb
 CHECK(room_window_visits IS NULL OR jsonb_typeof(room_window_visits)='object');

CREATE FUNCTION private.room_fit_window_visit(p_previous jsonb,p_metadata jsonb,p_visited_at timestamptz)
RETURNS jsonb LANGUAGE plpgsql STABLE SET search_path=public,private AS $$
DECLARE capture jsonb:=p_metadata->'capture'; visits jsonb; key text;
BEGIN
 -- Metadata belongs to the worker. Unrecognizable old scratch conveys no
 -- window identity and must not manufacture a scheduling visit.
 IF jsonb_typeof(capture->'binding') IS DISTINCT FROM 'string' OR capture->>'binding'=''
   OR jsonb_typeof(capture->'implementation') IS DISTINCT FROM 'string' OR capture->>'implementation'=''
   OR jsonb_typeof(capture#>'{window,window_key}') IS DISTINCT FROM 'string'
   OR capture#>>'{window,window_key}'='' THEN RETURN p_previous; END IF;
 key:=capture#>>'{window,window_key}';
 visits:=CASE WHEN p_previous->'binding'=capture->'binding'
   AND p_previous->'implementation'=capture->'implementation'
   AND jsonb_typeof(p_previous->'windows')='object' THEN p_previous->'windows' ELSE '{}'::jsonb END;
 RETURN jsonb_build_object('binding',capture->'binding','implementation',capture->'implementation',
   'windows',visits||jsonb_build_object(key,p_visited_at));
END; $$;

CREATE FUNCTION private.record_room_fit_window_visit() RETURNS trigger
LANGUAGE plpgsql SET search_path=public,private AS $$
BEGIN
 -- checkpoint_energy_room_fit already owns the job lock and fenced lease.
 -- Updating this scheduling column cannot invalidate its newly inserted scratch.
 UPDATE private.energy_learning_jobs SET room_window_visits=
   private.room_fit_window_visit(room_window_visits,NEW.metadata,now())
 WHERE id=NEW.job_id AND owner_kind='room' AND generation=NEW.generation;
 RETURN NEW;
END; $$;
CREATE TRIGGER record_room_fit_window_visit AFTER INSERT ON private.energy_room_fit_progress
 FOR EACH ROW EXECUTE FUNCTION private.record_room_fit_window_visit();

-- Existing in-flight captures have already received a turn. Seed only their
-- recognizable window identities, without writing completed evidence or models.
DO $$
DECLARE progress record; visited_at timestamptz;
BEGIN
 FOR progress IN SELECT p.job_id,p.metadata FROM private.energy_room_fit_progress p
   JOIN private.energy_learning_jobs j ON j.id=p.job_id AND j.owner_kind='room' AND j.generation=p.generation
 LOOP
   BEGIN
     visited_at:=(progress.metadata#>>'{capture,attemptedAt}')::timestamptz;
   EXCEPTION WHEN invalid_datetime_format OR datetime_field_overflow THEN visited_at:=NULL;
   END;
   IF visited_at IS NULL OR NOT isfinite(visited_at) THEN visited_at:=now(); END IF;
   UPDATE private.energy_learning_jobs SET room_window_visits=
     private.room_fit_window_visit(room_window_visits,progress.metadata,visited_at) WHERE id=progress.job_id;
 END LOOP;
END; $$;

REVOKE ALL ON FUNCTION private.room_fit_window_visit(jsonb,jsonb,timestamptz),
 private.record_room_fit_window_visit() FROM PUBLIC,anon,authenticated,service_role;
