-- Accuracy follows its inputs instead of the clock. A new plan, measured quarter
-- or published price queues one job at the end of its five-minute bucket, so a
-- home is recalculated at most every five minutes, with everything that arrived
-- in the bucket, and not at all while nothing changes.

-- Reporting owns its own state: queuing can never fail the write that caused it.
CREATE FUNCTION private.queue_energy_accuracy(p_home_ids uuid[])
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,private AS $$
DECLARE
  due timestamptz := date_bin('5 minutes', clock_timestamp(), timestamptz '2000-01-01 00:00:00+00') + interval '5 minutes';
  h uuid; customer uuid; zone text;
BEGIN
  FOREACH h IN ARRAY p_home_ids LOOP
    CONTINUE WHEN EXISTS(SELECT 1 FROM private.energy_accuracy_jobs WHERE home_id=h AND scheduled_at=due);
    -- The plan document is large: read its time zone only for a new job.
    SELECT customer_id, plan->>'timezone' INTO customer, zone FROM public.energy_optimisation_current
      WHERE home_id=h AND plan_id IS NOT NULL;
    CONTINUE WHEN zone IS NULL;
    INSERT INTO private.energy_accuracy_jobs(home_id,customer_id,scheduled_at,timezone)
      VALUES(h,customer,due,zone) ON CONFLICT(home_id,scheduled_at) DO NOTHING;
  END LOOP;
EXCEPTION WHEN OTHERS THEN
  RAISE WARNING 'Energy accuracy job was not queued: %', SQLERRM;
END; $$;

CREATE FUNCTION private.energy_accuracy_inputs_changed()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,private AS $$
BEGIN
  PERFORM private.queue_energy_accuracy(ARRAY(SELECT DISTINCT home_id FROM changed_rows));
  RETURN NULL;
END; $$;
REVOKE ALL ON FUNCTION private.queue_energy_accuracy(uuid[]),private.energy_accuracy_inputs_changed()
  FROM PUBLIC,anon,authenticated,service_role;

CREATE TRIGGER energy_accuracy_forecast_inserted AFTER INSERT ON public.energy_forecast_records
  REFERENCING NEW TABLE AS changed_rows FOR EACH STATEMENT EXECUTE FUNCTION private.energy_accuracy_inputs_changed();
CREATE TRIGGER energy_accuracy_actuals_inserted AFTER INSERT ON public.energy_optimisation_actual_slots
  REFERENCING NEW TABLE AS changed_rows FOR EACH STATEMENT EXECUTE FUNCTION private.energy_accuracy_inputs_changed();
CREATE TRIGGER energy_accuracy_actuals_updated AFTER UPDATE ON public.energy_optimisation_actual_slots
  REFERENCING NEW TABLE AS changed_rows FOR EACH STATEMENT EXECUTE FUNCTION private.energy_accuracy_inputs_changed();
CREATE TRIGGER energy_accuracy_devices_inserted AFTER INSERT ON public.energy_optimisation_device_slots
  REFERENCING NEW TABLE AS changed_rows FOR EACH STATEMENT EXECUTE FUNCTION private.energy_accuracy_inputs_changed();
CREATE TRIGGER energy_accuracy_devices_updated AFTER UPDATE ON public.energy_optimisation_device_slots
  REFERENCING NEW TABLE AS changed_rows FOR EACH STATEMENT EXECUTE FUNCTION private.energy_accuracy_inputs_changed();
CREATE TRIGGER energy_accuracy_prices_inserted AFTER INSERT ON public.energy_optimisation_price_slots
  REFERENCING NEW TABLE AS changed_rows FOR EACH STATEMENT EXECUTE FUNCTION private.energy_accuracy_inputs_changed();
CREATE TRIGGER energy_accuracy_prices_updated AFTER UPDATE ON public.energy_optimisation_price_slots
  REFERENCING NEW TABLE AS changed_rows FOR EACH STATEMENT EXECUTE FUNCTION private.energy_accuracy_inputs_changed();

-- The sweep no longer schedules: it posts each queued job once its bucket has
-- closed. Readers want only the latest report, so two days of them is enough.
CREATE OR REPLACE FUNCTION private.sweep_energy_accuracy()
RETURNS void LANGUAGE plpgsql SET search_path=public,private AS $$
DECLARE j record; c private.energy_accuracy_credentials%ROWTYPE;
BEGIN
  SELECT * INTO STRICT c FROM private.energy_accuracy_credentials WHERE singleton;
  IF c.function_url IS NOT NULL THEN
    FOR j IN SELECT * FROM private.energy_accuracy_jobs WHERE finished_at IS NULL AND scheduled_at<=clock_timestamp()
      AND (lease_until IS NULL OR lease_until<clock_timestamp()) LOOP
      PERFORM net.http_post(url:=c.function_url,
        headers:=jsonb_build_object('Content-Type','application/json','x-energy-accuracy-token',c.token),
        body:=jsonb_build_object('home_id',j.home_id,'scheduled_at',j.scheduled_at),timeout_milliseconds:=60000);
    END LOOP;
  END IF;
  DELETE FROM public.energy_forecast_records WHERE horizon_end<clock_timestamp()-interval '7 days';
  DELETE FROM public.energy_forecast_accuracy_reports WHERE scheduled_at<clock_timestamp()-interval '2 days';
  DELETE FROM private.energy_accuracy_jobs WHERE scheduled_at<clock_timestamp()-interval '2 days' AND finished_at IS NOT NULL;
END; $$;
REVOKE ALL ON FUNCTION private.sweep_energy_accuracy() FROM PUBLIC,anon,authenticated,service_role;
DROP FUNCTION private.energy_accuracy_due(timestamptz,text);

-- Every planned home starts from a fresh report instead of the last 06:00 or 18:00 one.
SELECT private.queue_energy_accuracy(ARRAY(SELECT home_id FROM public.energy_optimisation_current WHERE plan_id IS NOT NULL));
