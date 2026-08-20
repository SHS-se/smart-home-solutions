-- Separate server generation from Home Assistant acceptance (§5.7.3).
-- Existing rows pre-date acknowledgement and are therefore pending, never
-- silently described as executable.

ALTER TABLE public.energy_optimisation_current
  ADD COLUMN IF NOT EXISTS plan_id uuid,
  ADD COLUMN IF NOT EXISTS generation_request_id text,
  ADD COLUMN IF NOT EXISTS plan_schema_version smallint,
  ADD COLUMN IF NOT EXISTS ha_ack_status text NOT NULL DEFAULT 'pending',
  ADD COLUMN IF NOT EXISTS ha_acknowledged_at timestamptz,
  ADD COLUMN IF NOT EXISTS ha_integration_version text,
  ADD COLUMN IF NOT EXISTS ha_ack_request_id text,
  ADD COLUMN IF NOT EXISTS ha_ack_error jsonb;

UPDATE public.energy_optimisation_current
SET
  plan_id = CASE
    WHEN plan->>'plan_id' ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
      THEN (plan->>'plan_id')::uuid
    ELSE plan_id
  END,
  plan_schema_version = COALESCE(
    plan_schema_version,
    CASE WHEN plan->>'schema_version' ~ '^[0-9]+$'
      THEN (plan->>'schema_version')::smallint END
  )
WHERE plan_id IS NULL OR plan_schema_version IS NULL;

ALTER TABLE public.energy_optimisation_current
  DROP CONSTRAINT IF EXISTS energy_optimisation_current_ack_status;
ALTER TABLE public.energy_optimisation_current
  ADD CONSTRAINT energy_optimisation_current_ack_status
  CHECK (ha_ack_status IN ('pending', 'accepted', 'rejected'));

ALTER TABLE public.energy_optimisation_current
  DROP CONSTRAINT IF EXISTS energy_optimisation_current_ack_shape;
ALTER TABLE public.energy_optimisation_current
  ADD CONSTRAINT energy_optimisation_current_ack_shape CHECK (
    (ha_ack_status = 'pending' AND ha_acknowledged_at IS NULL)
    OR
    (ha_ack_status = 'accepted' AND ha_acknowledged_at IS NOT NULL AND ha_ack_error IS NULL)
    OR
    (ha_ack_status = 'rejected' AND ha_acknowledged_at IS NOT NULL AND ha_ack_error IS NOT NULL)
  );

ALTER TABLE public.energy_optimisation_plan_runs
  ADD COLUMN IF NOT EXISTS generation_request_id text,
  ADD COLUMN IF NOT EXISTS plan_schema_version smallint,
  ADD COLUMN IF NOT EXISTS ha_ack_status text NOT NULL DEFAULT 'pending',
  ADD COLUMN IF NOT EXISTS ha_acknowledged_at timestamptz,
  ADD COLUMN IF NOT EXISTS ha_integration_version text,
  ADD COLUMN IF NOT EXISTS ha_ack_request_id text,
  ADD COLUMN IF NOT EXISTS ha_ack_error jsonb;

UPDATE public.energy_optimisation_plan_runs AS run
SET plan_schema_version = current.plan_schema_version
FROM public.energy_optimisation_current AS current
WHERE run.home_id = current.home_id
  AND run.snapshot_id = current.snapshot_id
  AND run.plan_schema_version IS NULL;

ALTER TABLE public.energy_optimisation_plan_runs
  DROP CONSTRAINT IF EXISTS energy_optimisation_runs_ack_status;
ALTER TABLE public.energy_optimisation_plan_runs
  ADD CONSTRAINT energy_optimisation_runs_ack_status
  CHECK (ha_ack_status IN ('pending', 'accepted', 'rejected'));

ALTER TABLE public.energy_optimisation_plan_runs
  DROP CONSTRAINT IF EXISTS energy_optimisation_runs_ack_shape;
ALTER TABLE public.energy_optimisation_plan_runs
  ADD CONSTRAINT energy_optimisation_runs_ack_shape CHECK (
    (ha_ack_status = 'pending' AND ha_acknowledged_at IS NULL)
    OR
    (ha_ack_status = 'accepted' AND ha_acknowledged_at IS NOT NULL AND ha_ack_error IS NULL)
    OR
    (ha_ack_status = 'rejected' AND ha_acknowledged_at IS NOT NULL AND ha_ack_error IS NOT NULL)
  );

COMMENT ON COLUMN public.energy_optimisation_current.ha_ack_status IS
  'Home Assistant contract acknowledgement for this exact plan, not planner feasibility.';
COMMENT ON COLUMN public.energy_optimisation_current.generation_request_id IS
  'Correlation ID returned to Home Assistant and displayed in portal diagnostics.';

CREATE OR REPLACE FUNCTION public.acknowledge_energy_optimisation_plan(
  p_home_id uuid,
  p_plan_id uuid,
  p_snapshot_id uuid,
  p_plan_schema_version smallint,
  p_ack_status text,
  p_acknowledged_at timestamptz,
  p_integration_version text,
  p_ack_request_id text,
  p_ack_error jsonb
)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  updated_count integer;
BEGIN
  IF p_ack_status NOT IN ('accepted', 'rejected') THEN
    RAISE EXCEPTION 'invalid acknowledgement status';
  END IF;

  UPDATE public.energy_optimisation_current
  SET
    ha_ack_status = p_ack_status,
    ha_acknowledged_at = p_acknowledged_at,
    ha_integration_version = p_integration_version,
    ha_ack_request_id = p_ack_request_id,
    ha_ack_error = p_ack_error,
    updated_at = now()
  WHERE home_id = p_home_id
    AND plan_id = p_plan_id
    AND snapshot_id = p_snapshot_id
    AND plan_schema_version = p_plan_schema_version;

  GET DIAGNOSTICS updated_count = ROW_COUNT;
  IF updated_count = 0 THEN
    RETURN false;
  END IF;

  UPDATE public.energy_optimisation_plan_runs
  SET
    ha_ack_status = p_ack_status,
    ha_acknowledged_at = p_acknowledged_at,
    ha_integration_version = p_integration_version,
    ha_ack_request_id = p_ack_request_id,
    ha_ack_error = p_ack_error
  WHERE id = p_plan_id
    AND home_id = p_home_id
    AND snapshot_id = p_snapshot_id
    AND plan_schema_version = p_plan_schema_version;

  RETURN true;
END;
$$;

REVOKE ALL ON FUNCTION public.acknowledge_energy_optimisation_plan(
  uuid, uuid, uuid, smallint, text, timestamptz, text, text, jsonb
) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.acknowledge_energy_optimisation_plan(
  uuid, uuid, uuid, smallint, text, timestamptz, text, text, jsonb
) TO service_role;
