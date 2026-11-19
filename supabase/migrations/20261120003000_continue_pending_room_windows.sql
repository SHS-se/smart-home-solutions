-- A room owns the whole queued seasonal traversal. Publishing one band clears
-- its numerical scratch, then resumes the ordinary fenced job if more ready
-- windows remain. No subsequent planning request is needed to drain backfill.
CREATE FUNCTION private.continue_energy_room_windows() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,private AS $$
BEGIN
 IF EXISTS (
   SELECT FROM public.energy_optimisation_zone_models m
   JOIN private.energy_room_heating_contexts(NEW.home_id) c
     ON c.room_key=m.room_key AND c.binding=m.heating_bands->>'binding'
   WHERE m.home_id=NEW.home_id AND m.room_key=NEW.owner_key
     AND coalesce((m.heating_bands->>'pending_windows')::integer,0)>0
 ) THEN
   UPDATE private.energy_learning_jobs SET pending=true,lease_until=NULL,
     wake_after=now(),finished_at=NULL
   WHERE id=NEW.id AND generation=NEW.generation AND fence=NEW.fence
     AND NOT pending AND last_error IS NULL;
   IF FOUND THEN PERFORM private.wake_energy_learning_job(NEW.id); END IF;
 END IF;
 RETURN NEW;
END; $$;
CREATE TRIGGER continue_energy_room_windows AFTER UPDATE ON private.energy_learning_jobs
 FOR EACH ROW WHEN (OLD.pending AND NOT NEW.pending AND NEW.owner_kind='room'
   AND NEW.last_error IS NULL AND NEW.finished_at IS NOT NULL
   AND NEW.home_id=OLD.home_id AND NEW.customer_id=OLD.customer_id
   AND NEW.owner_key=OLD.owner_key AND NEW.generation=OLD.generation AND NEW.fence=OLD.fence)
 EXECUTE FUNCTION private.continue_energy_room_windows();
REVOKE ALL ON FUNCTION private.continue_energy_room_windows() FROM PUBLIC,anon,authenticated,service_role;
