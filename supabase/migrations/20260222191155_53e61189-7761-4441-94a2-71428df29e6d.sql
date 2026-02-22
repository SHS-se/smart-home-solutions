
-- =============================================================
-- Phase 1: Performance Data System – Database Migration
-- =============================================================

-- 1a. Evolve device_profiles table
-- Add mode column (heating/cooling)
ALTER TABLE public.device_profiles
  ADD COLUMN mode text NOT NULL DEFAULT 'heating';

-- Add metadata column
ALTER TABLE public.device_profiles
  ADD COLUMN metadata jsonb;

-- Drop the old unique constraint (one profile per device)
ALTER TABLE public.device_profiles
  DROP CONSTRAINT device_profiles_device_id_key;

-- Add new unique constraint (one profile per device+mode+kind)
ALTER TABLE public.device_profiles
  ADD CONSTRAINT device_profiles_device_mode_kind_key
    UNIQUE (device_id, mode, profile_kind);

-- 1b. Create device_profile_points table
CREATE TABLE public.device_profile_points (
  id uuid NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  profile_id uuid NOT NULL REFERENCES public.device_profiles(id) ON DELETE CASCADE,
  temp_c numeric NOT NULL,
  indoor_temp_c numeric,
  cop numeric,
  capacity_w integer,
  input_power_w integer,
  created_at timestamptz NOT NULL DEFAULT now()
);

-- Index for fast lookups
CREATE INDEX idx_device_profile_points_profile_temp
  ON public.device_profile_points (profile_id, temp_c);

-- Enable RLS
ALTER TABLE public.device_profile_points ENABLE ROW LEVEL SECURITY;

-- RLS: Staff full access
CREATE POLICY "Staff full access device_profile_points"
  ON public.device_profile_points FOR ALL
  USING (is_staff(auth.uid()));

-- RLS: Customers view points for own or global devices
CREATE POLICY "Customers view device_profile_points for own or global devices"
  ON public.device_profile_points FOR SELECT
  USING (EXISTS (
    SELECT 1 FROM device_profiles dp
    JOIN device_instances di ON di.id = dp.device_id
    WHERE dp.id = device_profile_points.profile_id
      AND (di.customer_id = get_customer_id_for_user(auth.uid()) OR di.customer_id IS NULL)
  ));

-- RLS: Customers insert points for own devices
CREATE POLICY "Customers insert device_profile_points for own devices"
  ON public.device_profile_points FOR INSERT
  WITH CHECK (EXISTS (
    SELECT 1 FROM device_profiles dp
    JOIN device_instances di ON di.id = dp.device_id
    WHERE dp.id = device_profile_points.profile_id
      AND di.customer_id = get_customer_id_for_user(auth.uid())
  ));

-- RLS: Customers update points for own devices
CREATE POLICY "Customers update device_profile_points for own devices"
  ON public.device_profile_points FOR UPDATE
  USING (EXISTS (
    SELECT 1 FROM device_profiles dp
    JOIN device_instances di ON di.id = dp.device_id
    WHERE dp.id = device_profile_points.profile_id
      AND di.customer_id = get_customer_id_for_user(auth.uid())
  ));

-- RLS: Customers delete points for own devices
CREATE POLICY "Customers delete device_profile_points for own devices"
  ON public.device_profile_points FOR DELETE
  USING (EXISTS (
    SELECT 1 FROM device_profiles dp
    JOIN device_instances di ON di.id = dp.device_id
    WHERE dp.id = device_profile_points.profile_id
      AND di.customer_id = get_customer_id_for_user(auth.uid())
  ));

-- 1c. Add performance_data_device_id to device_instances
ALTER TABLE public.device_instances
  ADD COLUMN performance_data_device_id uuid
    REFERENCES public.device_instances(id);

-- Trigger to prevent self-referencing
CREATE OR REPLACE FUNCTION public.validate_performance_data_device_id()
  RETURNS trigger
  LANGUAGE plpgsql
  SET search_path TO 'public'
AS $$
BEGIN
  IF NEW.performance_data_device_id IS NOT NULL
     AND NEW.performance_data_device_id = NEW.id THEN
    RAISE EXCEPTION 'A device cannot reference itself for performance data';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER trg_validate_performance_data_device_id
  BEFORE INSERT OR UPDATE ON public.device_instances
  FOR EACH ROW
  EXECUTE FUNCTION public.validate_performance_data_device_id();
