-- One observation horizon per seasonal traversal; later quarters belong to
-- the next ordinary refit. Uploads and live planning reads remain unbounded.
ALTER TABLE private.energy_learning_jobs ADD COLUMN room_history_to timestamptz;

-- Preserve current numerical scratch, fences and generations. A staged
-- capture supplies its original clock, raised to contain its whole window.
UPDATE private.energy_learning_jobs SET room_history_to=statement_timestamp() WHERE owner_kind='room';
DO $$
DECLARE progress record; attempted timestamptz; window_end timestamptz;
BEGIN
 FOR progress IN SELECT p.job_id,p.metadata FROM private.energy_room_fit_progress p
   JOIN private.energy_learning_jobs j ON j.id=p.job_id AND j.owner_kind='room' AND j.generation=p.generation
 LOOP
   -- Invalid disposable scratch must not stop the schema rollout. The normal
   -- worker already discards unrecognizable captures; preserve their contents.
   BEGIN attempted:=(progress.metadata#>>'{capture,attemptedAt}')::timestamptz;
   EXCEPTION WHEN data_exception THEN attempted:=NULL; END;
   BEGIN window_end:=(progress.metadata#>>'{capture,window,to_at}')::timestamptz;
   EXCEPTION WHEN data_exception THEN window_end:=NULL; END;
   IF NOT isfinite(attempted) THEN attempted:=NULL; END IF;
   IF NOT isfinite(window_end) THEN window_end:=NULL; END IF;
   UPDATE private.energy_learning_jobs SET room_history_to=coalesce(greatest(attempted,window_end),statement_timestamp())
   WHERE id=progress.job_id;
 END LOOP;
END; $$;

CREATE FUNCTION private.capture_room_learning_horizon() RETURNS trigger
LANGUAGE plpgsql SET search_path=public,private AS $$
BEGIN
 IF NEW.owner_kind<>'room' THEN NEW.room_history_to:=NULL;
 ELSIF TG_OP='INSERT' THEN NEW.room_history_to:=statement_timestamp();
 ELSIF OLD.owner_kind IS DISTINCT FROM NEW.owner_kind
   OR OLD.home_id IS DISTINCT FROM NEW.home_id OR OLD.customer_id IS DISTINCT FROM NEW.customer_id
   OR OLD.owner_key IS DISTINCT FROM NEW.owner_key OR OLD.generation IS DISTINCT FROM NEW.generation THEN
   NEW.room_history_to:=statement_timestamp();
 ELSE
   NEW.room_history_to:=OLD.room_history_to;
 END IF;
 RETURN NEW;
END; $$;
CREATE TRIGGER capture_room_learning_horizon BEFORE INSERT OR UPDATE ON private.energy_learning_jobs
 FOR EACH ROW EXECUTE FUNCTION private.capture_room_learning_horizon();
ALTER TABLE private.energy_learning_jobs ADD CONSTRAINT room_learning_history_horizon CHECK (
 (owner_kind='room' AND room_history_to IS NOT NULL AND isfinite(room_history_to))
 OR (owner_kind<>'room' AND room_history_to IS NULL));
REVOKE ALL ON FUNCTION private.capture_room_learning_horizon() FROM PUBLIC,anon,authenticated,service_role;
