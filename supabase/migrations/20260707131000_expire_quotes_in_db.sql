-- Move quote auto-expiry into the database.
--
-- The expire-quotes edge function used to be fully unauthenticated and relied
-- on a dashboard-created cron job (config living outside migrations). Expiry
-- is a pure data operation, so run it directly in Postgres via pg_cron: no
-- HTTP hop, no secret to manage, and the schedule is now version-controlled.
-- The edge function remains as a staff-only manual trigger.

CREATE OR REPLACE FUNCTION public.expire_due_quotes()
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_count integer;
BEGIN
  -- Callable by the cron job / service role (no auth context) and staff only.
  IF auth.uid() IS NOT NULL AND NOT is_staff(auth.uid()) THEN
    RAISE EXCEPTION 'Staff only';
  END IF;

  WITH expired AS (
    UPDATE quotes
    SET status = 'expired', status_reason = 'auto_expired'
    WHERE expires_at IS NOT NULL
      AND expires_at < now()
      AND status IN ('sent', 'viewed', 'revision_requested')
    RETURNING id
  ),
  logged AS (
    INSERT INTO quote_events (quote_id, event_type, actor_type, metadata)
    SELECT id, 'expired', 'system', '{"reason": "auto_expired"}'::jsonb
    FROM expired
    RETURNING quote_id
  )
  SELECT count(*) INTO v_count FROM expired;

  RETURN v_count;
END;
$$;

-- Only the cron job (runs as the function owner) and staff tooling may call it.
REVOKE EXECUTE ON FUNCTION public.expire_due_quotes() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.expire_due_quotes() TO authenticated, service_role;

-- Hourly is plenty: quote validity is measured in days.
-- cron.schedule upserts by job name, so re-running this migration is safe.
SELECT cron.schedule(
  'expire-due-quotes-hourly',
  '17 * * * *',
  $$SELECT public.expire_due_quotes()$$
);
