-- Reporting owns its own clock and state. It cannot reject or replace a plan.
CREATE TABLE public.energy_forecast_records (
  home_id uuid NOT NULL REFERENCES public.homes(id) ON DELETE CASCADE,
  customer_id uuid NOT NULL REFERENCES public.customers(id) ON DELETE CASCADE,
  plan_id uuid NOT NULL,
  published_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  horizon_end timestamptz NOT NULL,
  forecast jsonb NOT NULL,
  PRIMARY KEY(home_id,plan_id),
  CHECK(public.energy_home_matches_customer(home_id,customer_id))
);
CREATE INDEX energy_forecast_records_window ON public.energy_forecast_records(home_id,horizon_end,published_at);
ALTER TABLE public.energy_forecast_records ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.energy_forecast_records FROM PUBLIC,anon,authenticated;
GRANT SELECT,INSERT ON public.energy_forecast_records TO service_role;

CREATE TABLE public.energy_forecast_accuracy_reports (
  home_id uuid NOT NULL REFERENCES public.homes(id) ON DELETE CASCADE,
  customer_id uuid NOT NULL REFERENCES public.customers(id) ON DELETE CASCADE,
  scheduled_at timestamptz NOT NULL,
  report jsonb NOT NULL,
  diagnostics jsonb NOT NULL,
  PRIMARY KEY(home_id,scheduled_at),
  CHECK(public.energy_home_matches_customer(home_id,customer_id))
);
ALTER TABLE public.energy_forecast_accuracy_reports ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.energy_forecast_accuracy_reports FROM PUBLIC,anon,authenticated;
GRANT SELECT ON public.energy_forecast_accuracy_reports TO authenticated,service_role;
CREATE POLICY own_energy_forecast_accuracy ON public.energy_forecast_accuracy_reports FOR SELECT TO authenticated
  USING(public.can_access_energy_billing_customer(customer_id));

CREATE FUNCTION public.get_energy_forecast_accuracy(p_home_id uuid)
RETURNS jsonb LANGUAGE sql STABLE SECURITY INVOKER SET search_path=public AS $$
  SELECT report || jsonb_build_object('calculations',diagnostics) FROM public.energy_forecast_accuracy_reports
    WHERE home_id=p_home_id ORDER BY scheduled_at DESC LIMIT 1;
$$;
REVOKE ALL ON FUNCTION public.get_energy_forecast_accuracy(uuid) FROM PUBLIC,anon;
GRANT EXECUTE ON FUNCTION public.get_energy_forecast_accuracy(uuid) TO authenticated,service_role;

CREATE TABLE private.energy_accuracy_credentials (
  singleton boolean PRIMARY KEY DEFAULT true CHECK(singleton),
  token text NOT NULL,
  function_url text CHECK(function_url ~ '^https://[a-z0-9]+\.supabase\.co/functions/v1/energy-forecast-accuracy$')
);
INSERT INTO private.energy_accuracy_credentials VALUES(true,encode(extensions.gen_random_bytes(32),'hex'),NULL);
CREATE TABLE private.energy_accuracy_jobs (
  home_id uuid NOT NULL REFERENCES public.homes(id) ON DELETE CASCADE,
  customer_id uuid NOT NULL REFERENCES public.customers(id) ON DELETE CASCADE,
  scheduled_at timestamptz NOT NULL,
  timezone text NOT NULL,
  fence bigint NOT NULL DEFAULT 0,
  lease_until timestamptz,
  finished_at timestamptz,
  last_error text,
  PRIMARY KEY(home_id,scheduled_at)
);
ALTER TABLE private.energy_accuracy_credentials ENABLE ROW LEVEL SECURITY;
ALTER TABLE private.energy_accuracy_jobs ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON private.energy_accuracy_credentials,private.energy_accuracy_jobs FROM PUBLIC,anon,authenticated,service_role;

CREATE FUNCTION public.verify_energy_accuracy_token(p_token text)
RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path=public,private AS $$
  SELECT COALESCE((SELECT token=p_token FROM private.energy_accuracy_credentials WHERE singleton),false);
$$;
CREATE FUNCTION private.energy_accuracy_due(p_now timestamptz,p_timezone text)
RETURNS timestamptz LANGUAGE sql STABLE AS $$
  SELECT (CASE WHEN local_at::time >= time '18:00' THEN local_at::date + time '18:00'
    WHEN local_at::time >= time '06:00' THEN local_at::date + time '06:00'
    ELSE (local_at::date - 1) + time '18:00' END) AT TIME ZONE p_timezone
  FROM (SELECT p_now AT TIME ZONE p_timezone AS local_at) t;
$$;

CREATE FUNCTION public.claim_energy_accuracy_job(p_home_id uuid,p_scheduled_at timestamptz)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,private AS $$
DECLARE j private.energy_accuracy_jobs%ROWTYPE;
BEGIN
  UPDATE private.energy_accuracy_jobs SET fence=fence+1,lease_until=clock_timestamp()+interval '2 minutes'
    WHERE home_id=p_home_id AND scheduled_at=p_scheduled_at AND finished_at IS NULL
      AND (lease_until IS NULL OR lease_until<clock_timestamp()) RETURNING * INTO j;
  IF NOT FOUND THEN RETURN NULL; END IF;
  RETURN to_jsonb(j);
END; $$;
CREATE FUNCTION public.complete_energy_accuracy_job(p_home_id uuid,p_scheduled_at timestamptz,p_fence bigint,p_report jsonb,p_diagnostics jsonb)
RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,private AS $$
DECLARE j private.energy_accuracy_jobs%ROWTYPE;
BEGIN
  SELECT * INTO j FROM private.energy_accuracy_jobs WHERE home_id=p_home_id AND scheduled_at=p_scheduled_at FOR UPDATE;
  IF j.fence IS DISTINCT FROM p_fence OR j.finished_at IS NOT NULL OR j.lease_until IS NULL THEN RETURN false; END IF;
  IF (p_report->>'scheduled_at')::timestamptz IS DISTINCT FROM j.scheduled_at THEN RAISE EXCEPTION 'Accuracy report identity mismatch'; END IF;
  INSERT INTO public.energy_forecast_accuracy_reports VALUES(j.home_id,j.customer_id,j.scheduled_at,p_report,p_diagnostics)
    ON CONFLICT(home_id,scheduled_at) DO NOTHING;
  UPDATE private.energy_accuracy_jobs SET finished_at=clock_timestamp(),lease_until=NULL,last_error=NULL
    WHERE home_id=p_home_id AND scheduled_at=p_scheduled_at;
  RETURN true;
END; $$;
CREATE FUNCTION public.fail_energy_accuracy_job(p_home_id uuid,p_scheduled_at timestamptz,p_fence bigint,p_error text)
RETURNS void LANGUAGE sql SECURITY DEFINER SET search_path=public,private AS $$
  UPDATE private.energy_accuracy_jobs SET last_error=left(p_error,2000),lease_until=clock_timestamp()+interval '1 minute'
    WHERE home_id=p_home_id AND scheduled_at=p_scheduled_at AND fence=p_fence AND finished_at IS NULL;
$$;
REVOKE ALL ON FUNCTION public.verify_energy_accuracy_token(text),public.claim_energy_accuracy_job(uuid,timestamptz),
  public.complete_energy_accuracy_job(uuid,timestamptz,bigint,jsonb,jsonb),public.fail_energy_accuracy_job(uuid,timestamptz,bigint,text)
  FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.verify_energy_accuracy_token(text),public.claim_energy_accuracy_job(uuid,timestamptz),
  public.complete_energy_accuracy_job(uuid,timestamptz,bigint,jsonb,jsonb),public.fail_energy_accuracy_job(uuid,timestamptz,bigint,text) TO service_role;

CREATE FUNCTION private.sweep_energy_accuracy()
RETURNS void LANGUAGE plpgsql SET search_path=public,private AS $$
DECLARE j record; c private.energy_accuracy_credentials%ROWTYPE;
BEGIN
  INSERT INTO private.energy_accuracy_jobs(home_id,customer_id,scheduled_at,timezone)
    SELECT home_id,customer_id,private.energy_accuracy_due(clock_timestamp(),plan->>'timezone'),plan->>'timezone'
    FROM public.energy_optimisation_current WHERE plan_id IS NOT NULL AND plan->>'timezone' IS NOT NULL
    ON CONFLICT(home_id,scheduled_at) DO NOTHING;
  SELECT * INTO STRICT c FROM private.energy_accuracy_credentials WHERE singleton;
  IF c.function_url IS NOT NULL THEN
    FOR j IN SELECT * FROM private.energy_accuracy_jobs WHERE finished_at IS NULL
      AND (lease_until IS NULL OR lease_until<clock_timestamp()) LOOP
      PERFORM net.http_post(url:=c.function_url,
        headers:=jsonb_build_object('Content-Type','application/json','x-energy-accuracy-token',c.token),
        body:=jsonb_build_object('home_id',j.home_id,'scheduled_at',j.scheduled_at),timeout_milliseconds:=60000);
    END LOOP;
  END IF;
  DELETE FROM public.energy_forecast_records WHERE horizon_end<clock_timestamp()-interval '7 days';
  DELETE FROM public.energy_forecast_accuracy_reports WHERE scheduled_at<clock_timestamp()-interval '30 days';
  DELETE FROM private.energy_accuracy_jobs WHERE scheduled_at<clock_timestamp()-interval '30 days' AND finished_at IS NOT NULL;
END; $$;
REVOKE ALL ON FUNCTION private.sweep_energy_accuracy(),private.energy_accuracy_due(timestamptz,text) FROM PUBLIC,anon,authenticated,service_role;
SELECT cron.schedule('energy-forecast-accuracy','* * * * *',$job$SELECT private.sweep_energy_accuracy()$job$);
