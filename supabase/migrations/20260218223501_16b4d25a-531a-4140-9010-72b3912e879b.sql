
-- 1. Make customer_id nullable for global devices
ALTER TABLE public.device_instances ALTER COLUMN customer_id DROP NOT NULL;

-- 2. Update the cross-customer trigger to allow global devices (customer_id IS NULL)
CREATE OR REPLACE FUNCTION public.validate_assignment_customer_match()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $$
DECLARE v_dc uuid; v_hc uuid;
BEGIN
  SELECT customer_id INTO v_dc FROM public.device_instances WHERE id = NEW.device_instance_id;
  SELECT customer_id INTO v_hc FROM public.homes WHERE id = NEW.home_id;
  -- Allow global devices (NULL customer_id) to be assigned to any home
  IF v_dc IS NOT NULL AND v_dc IS DISTINCT FROM v_hc THEN
    RAISE EXCEPTION 'Cross-customer assignment blocked: device customer % != home customer %', v_dc, v_hc;
  END IF;
  RETURN NEW;
END;
$$;

-- 3. Update RLS: customers can also SELECT global devices (customer_id IS NULL)
DROP POLICY IF EXISTS "Customers view own device_instances" ON public.device_instances;
CREATE POLICY "Customers view own device_instances"
ON public.device_instances
FOR SELECT
USING (
  customer_id = get_customer_id_for_user(auth.uid())
  OR customer_id IS NULL
);
