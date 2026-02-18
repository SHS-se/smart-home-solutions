
-- ============================================================
-- Step 1: Add customer_id to device_instances
-- ============================================================
ALTER TABLE public.device_instances ADD COLUMN customer_id uuid;

UPDATE public.device_instances di
SET customer_id = h.customer_id
FROM public.homes h
WHERE h.id = di.home_id;

ALTER TABLE public.device_instances ALTER COLUMN customer_id SET NOT NULL;

ALTER TABLE public.device_instances
  ADD CONSTRAINT device_instances_customer_id_fkey
  FOREIGN KEY (customer_id) REFERENCES public.customers(id) ON DELETE CASCADE;

-- ============================================================
-- Step 2: Create home_device_assignments table
-- ============================================================
CREATE TABLE public.home_device_assignments (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  home_id uuid NOT NULL REFERENCES public.homes(id) ON DELETE CASCADE,
  device_instance_id uuid NOT NULL REFERENCES public.device_instances(id) ON DELETE CASCADE,
  quantity integer NOT NULL DEFAULT 1,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(home_id, device_instance_id)
);

CREATE OR REPLACE FUNCTION public.validate_assignment_quantity()
RETURNS trigger LANGUAGE plpgsql SET search_path TO 'public' AS $$
BEGIN
  IF NEW.quantity < 1 THEN
    RAISE EXCEPTION 'quantity must be >= 1, got %', NEW.quantity;
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER trg_validate_assignment_quantity
  BEFORE INSERT OR UPDATE ON public.home_device_assignments
  FOR EACH ROW EXECUTE FUNCTION public.validate_assignment_quantity();

CREATE OR REPLACE FUNCTION public.validate_assignment_customer_match()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public' AS $$
DECLARE v_dc uuid; v_hc uuid;
BEGIN
  SELECT customer_id INTO v_dc FROM public.device_instances WHERE id = NEW.device_instance_id;
  SELECT customer_id INTO v_hc FROM public.homes WHERE id = NEW.home_id;
  IF v_dc IS DISTINCT FROM v_hc THEN
    RAISE EXCEPTION 'Cross-customer assignment blocked: device customer % != home customer %', v_dc, v_hc;
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER trg_validate_assignment_customer_match
  BEFORE INSERT OR UPDATE ON public.home_device_assignments
  FOR EACH ROW EXECUTE FUNCTION public.validate_assignment_customer_match();

-- ============================================================
-- Step 3: Migrate existing data to assignments
-- ============================================================
INSERT INTO public.home_device_assignments (home_id, device_instance_id, quantity)
SELECT di.home_id, di.id, di.quantity FROM public.device_instances di;

-- ============================================================
-- Step 4: Drop old RLS policies (reference home_id), then drop columns
-- ============================================================
DROP POLICY "Customers delete own device_instances" ON public.device_instances;
DROP POLICY "Customers insert own device_instances" ON public.device_instances;
DROP POLICY "Customers update own device_instances" ON public.device_instances;
DROP POLICY "Customers view own device_instances" ON public.device_instances;

ALTER TABLE public.device_instances DROP COLUMN home_id;
ALTER TABLE public.device_instances DROP COLUMN quantity;

-- ============================================================
-- Step 5: New RLS for device_instances (customer_id based)
-- ============================================================
CREATE POLICY "Customers view own device_instances"
  ON public.device_instances FOR SELECT
  USING (customer_id = get_customer_id_for_user(auth.uid()));

CREATE POLICY "Customers insert own device_instances"
  ON public.device_instances FOR INSERT
  WITH CHECK (customer_id = get_customer_id_for_user(auth.uid()));

CREATE POLICY "Customers update own device_instances"
  ON public.device_instances FOR UPDATE
  USING (customer_id = get_customer_id_for_user(auth.uid()));

CREATE POLICY "Customers delete own device_instances"
  ON public.device_instances FOR DELETE
  USING (customer_id = get_customer_id_for_user(auth.uid()));

-- ============================================================
-- Step 6: RLS for home_device_assignments
-- ============================================================
ALTER TABLE public.home_device_assignments ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Staff full access home_device_assignments"
  ON public.home_device_assignments FOR ALL
  USING (is_staff(auth.uid()));

CREATE POLICY "Customers view own home_device_assignments"
  ON public.home_device_assignments FOR SELECT
  USING (EXISTS (SELECT 1 FROM homes h WHERE h.id = home_device_assignments.home_id AND h.customer_id = get_customer_id_for_user(auth.uid())));

CREATE POLICY "Customers insert own home_device_assignments"
  ON public.home_device_assignments FOR INSERT
  WITH CHECK (EXISTS (SELECT 1 FROM homes h WHERE h.id = home_device_assignments.home_id AND h.customer_id = get_customer_id_for_user(auth.uid())));

CREATE POLICY "Customers update own home_device_assignments"
  ON public.home_device_assignments FOR UPDATE
  USING (EXISTS (SELECT 1 FROM homes h WHERE h.id = home_device_assignments.home_id AND h.customer_id = get_customer_id_for_user(auth.uid())));

CREATE POLICY "Customers delete own home_device_assignments"
  ON public.home_device_assignments FOR DELETE
  USING (EXISTS (SELECT 1 FROM homes h WHERE h.id = home_device_assignments.home_id AND h.customer_id = get_customer_id_for_user(auth.uid())));

-- ============================================================
-- Step 7: Drop deprecated energy_devices table
-- ============================================================
DROP TABLE IF EXISTS public.energy_devices;
