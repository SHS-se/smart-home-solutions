-- Readers want only the latest report, so a newer closed bucket supersedes every
-- older open job of its home, and each home has at most one calculation in flight.
-- Posting every backlogged job each minute, each reading seven days of history,
-- exhausted the hosted instance and kept every job failing on timeouts.
CREATE OR REPLACE FUNCTION private.sweep_energy_accuracy()
RETURNS void LANGUAGE plpgsql SET search_path=public,private AS $$
DECLARE j record; c private.energy_accuracy_credentials%ROWTYPE;
BEGIN
  -- A leased job finishes or fails on its own; it is superseded once its lease lapses.
  DELETE FROM private.energy_accuracy_jobs o WHERE o.finished_at IS NULL
    AND (o.lease_until IS NULL OR o.lease_until<clock_timestamp())
    AND EXISTS(SELECT 1 FROM private.energy_accuracy_jobs n WHERE n.home_id=o.home_id
      AND n.finished_at IS NULL AND n.scheduled_at>o.scheduled_at AND n.scheduled_at<=clock_timestamp());
  SELECT * INTO STRICT c FROM private.energy_accuracy_credentials WHERE singleton;
  IF c.function_url IS NOT NULL THEN
    FOR j IN SELECT DISTINCT ON (home_id) home_id, scheduled_at FROM private.energy_accuracy_jobs
      WHERE finished_at IS NULL AND scheduled_at<=clock_timestamp() ORDER BY home_id, scheduled_at DESC LOOP
      CONTINUE WHEN EXISTS(SELECT 1 FROM private.energy_accuracy_jobs WHERE home_id=j.home_id
        AND finished_at IS NULL AND lease_until>=clock_timestamp());
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

-- Each claim advances the fence, so repeated failures of one job wait 1, 2, 4 … 30 minutes.
CREATE OR REPLACE FUNCTION public.fail_energy_accuracy_job(p_home_id uuid,p_scheduled_at timestamptz,p_fence bigint,p_error text)
RETURNS void LANGUAGE sql SECURITY DEFINER SET search_path=public,private AS $$
  UPDATE private.energy_accuracy_jobs SET last_error=left(p_error,2000),
    lease_until=clock_timestamp()+interval '1 minute'*least(30,power(2,greatest(p_fence-1,0)))
    WHERE home_id=p_home_id AND scheduled_at=p_scheduled_at AND fence=p_fence AND finished_at IS NULL;
$$;
