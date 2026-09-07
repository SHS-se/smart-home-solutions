-- Replanning asks the device for fresh measurements instead of reusing an aged snapshot.
--
-- "Planera om nu" used to re-solve the snapshot already on file. That snapshot
-- is only refreshed when Home Assistant pushes one, so for most of every
-- quarter it was already older than the planner's fifteen-minute freshness
-- limit and the button failed with `captured_at must describe a fresh
-- snapshot`. Nothing was wrong: the request was simply unanswerable from
-- stored state.
--
-- So a request is now recorded here and answered by the device on the normal
-- ingest path. That keeps one planning route rather than two, and means the
-- reply carries measurements taken after the button was pressed.
ALTER TABLE public.energy_optimisation_current
  ADD COLUMN replan_request_id uuid,
  ADD COLUMN replan_requested_at timestamptz,
  ADD COLUMN replan_completed_request_id uuid,
  ADD COLUMN replan_error text;

-- Serialize button clicks per home and reuse an outstanding request.
CREATE FUNCTION public.request_energy_optimisation_replan(p_home_id uuid)
RETURNS uuid
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = public
AS $$
DECLARE
  current_row public.energy_optimisation_current%ROWTYPE;
  requested uuid;
BEGIN
  SELECT * INTO current_row FROM public.energy_optimisation_current
    WHERE home_id = p_home_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'No energy snapshot for this home'; END IF;
  IF current_row.replan_request_id IS NOT NULL
     AND current_row.replan_request_id IS DISTINCT FROM current_row.replan_completed_request_id
     AND current_row.replan_error IS NULL THEN
    RETURN current_row.replan_request_id;
  END IF;
  requested := gen_random_uuid();
  UPDATE public.energy_optimisation_current
    SET replan_request_id = requested, replan_requested_at = now(), replan_error = NULL
    WHERE home_id = p_home_id;
  RETURN requested;
END;
$$;
REVOKE ALL ON FUNCTION public.request_energy_optimisation_replan(uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.request_energy_optimisation_replan(uuid) TO service_role;

-- Called by the ingest function after a plan has been stored.
--
-- A request is satisfied by any plan built from measurements taken after it was
-- made, not only by one the device deliberately tagged with its id. That is not
-- a leniency: the ingest path resolves the value curves from this table at
-- solve time rather than from the snapshot, so every plan it produces already
-- reflects whatever the household had saved when the button was pressed.
--
-- Recognising that matters because the device answers a tagged request only
-- once its own integration has been updated. Homes still on an older release
-- keep pushing on their quarter-hour cadence, and this clears their request on
-- the next push instead of leaving the portal waiting on a reply that version
-- cannot send. `p_request_id` remains the exact case: it completes a request
-- the instant the device answers it, without waiting on the clock comparison.
CREATE FUNCTION public.complete_energy_optimisation_replan(
  p_home_id uuid,
  p_captured_at timestamptz,
  p_request_id uuid DEFAULT NULL
)
RETURNS uuid
LANGUAGE sql
SECURITY INVOKER
SET search_path = public
AS $$
  UPDATE public.energy_optimisation_current
     SET replan_completed_request_id = replan_request_id,
         -- A plan supersedes whatever the previous attempt failed to say.
         replan_error = NULL
   WHERE home_id = p_home_id
     AND replan_request_id IS NOT NULL
     AND replan_request_id IS DISTINCT FROM replan_completed_request_id
     AND (replan_request_id = p_request_id OR replan_requested_at <= p_captured_at)
  RETURNING replan_request_id;
$$;
REVOKE ALL ON FUNCTION public.complete_energy_optimisation_replan(uuid, timestamptz, uuid)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.complete_energy_optimisation_replan(uuid, timestamptz, uuid)
  TO service_role;
