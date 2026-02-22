
-- Step A: Make device_template_id nullable and add device_type_id
ALTER TABLE public.device_instances ALTER COLUMN device_template_id DROP NOT NULL;
ALTER TABLE public.device_instances ADD COLUMN device_type_id uuid REFERENCES public.device_types(id);

-- Step B1: Create global devices from templates (device_template_id = NULL for these)
INSERT INTO public.device_instances (device_type_id, name, field_values, controllable, shiftable, priority, customer_id, device_template_id)
SELECT dt.device_type_id, dt.display_name, coalesce(dt.field_defaults, '{}'), dt.controllable_default, dt.shiftable_default, 0, NULL, NULL
FROM public.device_templates dt WHERE dt.is_deleted = false;

-- Step B2: Update existing customer device_instances with device_type_id from their template
UPDATE public.device_instances di
SET device_type_id = dt.device_type_id,
    field_values = coalesce(dt.field_defaults, '{}') || coalesce(di.field_values, '{}')
FROM public.device_templates dt
WHERE di.device_template_id = dt.id AND di.device_type_id IS NULL;

-- Step C: Create device_profiles table
CREATE TABLE public.device_profiles (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  device_id uuid NOT NULL REFERENCES public.device_instances(id) ON DELETE CASCADE,
  profile_kind text NOT NULL DEFAULT 'cop_capacity_curve',
  data jsonb NOT NULL DEFAULT '{}',
  source text,
  notes text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(device_id)
);

ALTER TABLE public.device_profiles ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Staff full access device_profiles"
  ON public.device_profiles FOR ALL
  USING (public.is_staff(auth.uid()));

CREATE POLICY "Customers view device_profiles for own or global devices"
  ON public.device_profiles FOR SELECT
  USING (
    EXISTS (
      SELECT 1 FROM public.device_instances di
      WHERE di.id = device_profiles.device_id
        AND (di.customer_id = public.get_customer_id_for_user(auth.uid()) OR di.customer_id IS NULL)
    )
  );

CREATE POLICY "Customers insert device_profiles for own devices"
  ON public.device_profiles FOR INSERT
  WITH CHECK (
    EXISTS (
      SELECT 1 FROM public.device_instances di
      WHERE di.id = device_profiles.device_id
        AND di.customer_id = public.get_customer_id_for_user(auth.uid())
    )
  );

CREATE POLICY "Customers update device_profiles for own devices"
  ON public.device_profiles FOR UPDATE
  USING (
    EXISTS (
      SELECT 1 FROM public.device_instances di
      WHERE di.id = device_profiles.device_id
        AND di.customer_id = public.get_customer_id_for_user(auth.uid())
    )
  );

CREATE POLICY "Customers delete device_profiles for own devices"
  ON public.device_profiles FOR DELETE
  USING (
    EXISTS (
      SELECT 1 FROM public.device_instances di
      WHERE di.id = device_profiles.device_id
        AND di.customer_id = public.get_customer_id_for_user(auth.uid())
    )
  );

-- Step D: Migrate existing device_template_profiles
INSERT INTO public.device_profiles (device_id, profile_kind, data, source, notes)
SELECT di.id, 'cop_capacity_curve', dtp.data, dtp.source, dtp.notes
FROM public.device_template_profiles dtp
JOIN public.device_templates dt ON dtp.device_template_id = dt.id
JOIN public.device_instances di ON di.name = dt.display_name 
  AND di.customer_id IS NULL AND di.device_type_id = dt.device_type_id
WHERE dtp.is_active = true
ON CONFLICT (device_id) DO NOTHING;

-- Step E: Finalize schema
ALTER TABLE public.device_instances ALTER COLUMN device_type_id SET NOT NULL;
ALTER TABLE public.device_instances DROP COLUMN device_template_id;
DROP TABLE public.device_template_profiles;
DROP TABLE public.device_templates;

-- Step F: Add updated_at trigger on device_profiles
CREATE TRIGGER update_device_profiles_updated_at
  BEFORE UPDATE ON public.device_profiles
  FOR EACH ROW
  EXECUTE FUNCTION public.update_simple_updated_at();
