
-- ============================================================
-- 1.1 Create homes table
-- ============================================================
CREATE TABLE public.homes (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  customer_id uuid NOT NULL REFERENCES public.customers(id) ON DELETE CASCADE,
  name text NOT NULL,
  address_text text NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX idx_homes_customer_id ON public.homes(customer_id);
ALTER TABLE public.homes ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Staff full access on homes"
  ON public.homes FOR ALL USING (public.is_staff(auth.uid()));
CREATE POLICY "Customers CRUD own homes"
  ON public.homes FOR ALL
  USING (customer_id = public.get_customer_id_for_user(auth.uid()))
  WITH CHECK (customer_id = public.get_customer_id_for_user(auth.uid()));

-- ============================================================
-- 1.2 energy_home_settings: add home_id
-- ============================================================
ALTER TABLE public.energy_home_settings ADD COLUMN home_id uuid NULL;

-- Create a home for each existing settings row
INSERT INTO public.homes (customer_id, name)
SELECT customer_id, 'Home' FROM public.energy_home_settings;

-- Link settings -> home
UPDATE public.energy_home_settings ehs
SET home_id = h.id
FROM public.homes h WHERE h.customer_id = ehs.customer_id;

ALTER TABLE public.energy_home_settings
  ALTER COLUMN home_id SET NOT NULL,
  ADD CONSTRAINT energy_home_settings_home_id_fkey FOREIGN KEY (home_id) REFERENCES public.homes(id) ON DELETE CASCADE;
ALTER TABLE public.energy_home_settings DROP CONSTRAINT IF EXISTS energy_home_settings_customer_id_key;
ALTER TABLE public.energy_home_settings ADD CONSTRAINT energy_home_settings_home_id_key UNIQUE (home_id);

-- RLS for energy_home_settings
DROP POLICY IF EXISTS "Customers read/write own energy_home_settings" ON public.energy_home_settings;
DROP POLICY IF EXISTS "Staff full access energy_home_settings" ON public.energy_home_settings;

CREATE POLICY "Staff full access energy_home_settings"
  ON public.energy_home_settings FOR ALL USING (public.is_staff(auth.uid()));
CREATE POLICY "Customers view own energy settings"
  ON public.energy_home_settings FOR SELECT
  USING (EXISTS (SELECT 1 FROM public.homes h WHERE h.id = home_id AND h.customer_id = public.get_customer_id_for_user(auth.uid())));
CREATE POLICY "Customers insert own energy settings"
  ON public.energy_home_settings FOR INSERT
  WITH CHECK (EXISTS (SELECT 1 FROM public.homes h WHERE h.id = home_id AND h.customer_id = public.get_customer_id_for_user(auth.uid())));
CREATE POLICY "Customers update own energy settings"
  ON public.energy_home_settings FOR UPDATE
  USING (EXISTS (SELECT 1 FROM public.homes h WHERE h.id = home_id AND h.customer_id = public.get_customer_id_for_user(auth.uid())));

-- ============================================================
-- 1.3 energy_devices: add home_id, drop energy_home_settings_id
-- ============================================================
-- MUST drop the old RLS policy first (it references energy_home_settings_id)
DROP POLICY IF EXISTS "Customers read/write own energy_devices" ON public.energy_devices;
DROP POLICY IF EXISTS "Staff full access energy_devices" ON public.energy_devices;

ALTER TABLE public.energy_devices ADD COLUMN home_id uuid NULL;

UPDATE public.energy_devices ed
SET home_id = ehs.home_id
FROM public.energy_home_settings ehs
WHERE ehs.id = ed.energy_home_settings_id;

ALTER TABLE public.energy_devices
  ALTER COLUMN home_id SET NOT NULL,
  ADD CONSTRAINT energy_devices_home_id_fkey FOREIGN KEY (home_id) REFERENCES public.homes(id) ON DELETE CASCADE;
CREATE INDEX idx_energy_devices_home_id ON public.energy_devices(home_id);

ALTER TABLE public.energy_devices DROP CONSTRAINT IF EXISTS energy_devices_energy_home_settings_id_fkey;
ALTER TABLE public.energy_devices DROP COLUMN energy_home_settings_id;

-- New RLS for energy_devices
CREATE POLICY "Staff full access energy_devices"
  ON public.energy_devices FOR ALL USING (public.is_staff(auth.uid()));
CREATE POLICY "Customers view own energy devices"
  ON public.energy_devices FOR SELECT
  USING (EXISTS (SELECT 1 FROM public.homes h WHERE h.id = home_id AND h.customer_id = public.get_customer_id_for_user(auth.uid())));
CREATE POLICY "Customers insert own energy devices"
  ON public.energy_devices FOR INSERT
  WITH CHECK (EXISTS (SELECT 1 FROM public.homes h WHERE h.id = home_id AND h.customer_id = public.get_customer_id_for_user(auth.uid())));
CREATE POLICY "Customers update own energy devices"
  ON public.energy_devices FOR UPDATE
  USING (EXISTS (SELECT 1 FROM public.homes h WHERE h.id = home_id AND h.customer_id = public.get_customer_id_for_user(auth.uid())));
CREATE POLICY "Customers delete own energy devices"
  ON public.energy_devices FOR DELETE
  USING (EXISTS (SELECT 1 FROM public.homes h WHERE h.id = home_id AND h.customer_id = public.get_customer_id_for_user(auth.uid())));

-- ============================================================
-- 1.4 device_templates: add make/model/display_name/device_kind/specs
-- ============================================================
ALTER TABLE public.device_templates
  ADD COLUMN make text NOT NULL DEFAULT '',
  ADD COLUMN model text NOT NULL DEFAULT '',
  ADD COLUMN display_name text NOT NULL DEFAULT '',
  ADD COLUMN device_kind text NOT NULL DEFAULT '',
  ADD COLUMN specs jsonb NOT NULL DEFAULT '{}'::jsonb;

UPDATE public.device_templates SET make='Generic', model='AA-12', display_name='Generic AA-12', device_kind='air_to_air_heat_pump', specs='{"rated_power_w":3500}'::jsonb WHERE id='28dd2120-533b-4ace-82c2-a160caa8d9a6';
UPDATE public.device_templates SET make='Generic', model='RH-2000', display_name='Generic RH-2000', device_kind='direct_electric_heater', specs='{"rated_power_w":2000}'::jsonb WHERE id='93444cd5-0e70-47ff-a3aa-9332facd3a25';
UPDATE public.device_templates SET make='Generic', model='EVC-11', display_name='Generic EVC-11', device_kind='ev_charger', specs='{"max_power_w":11000,"phases":3}'::jsonb WHERE id='86531696-a070-4a5c-9d72-69c05780bf38';
UPDATE public.device_templates SET make='Generic', model='DW-2000', display_name='Generic DW-2000', device_kind='appliance', specs='{"rated_power_w":2000}'::jsonb WHERE id='ca9ca5a6-0c2e-4976-bfc4-46b35d26b426';
UPDATE public.device_templates SET make='Generic', model='WM-2200', display_name='Generic WM-2200', device_kind='appliance', specs='{"rated_power_w":2200}'::jsonb WHERE id='49388143-ac7b-4b0c-9f4a-bcfe7a893782';
UPDATE public.device_templates SET make='Generic', model='BL-500', display_name='Generic BL-500', device_kind='base_load', specs='{"rated_power_w":500}'::jsonb WHERE id='d97bd83b-43d2-41fa-a091-857219d28d9a';

-- ============================================================
-- 1.5 device_template_profiles constraints
-- ============================================================
ALTER TABLE public.device_template_profiles
  ADD CONSTRAINT device_template_profiles_version_unique UNIQUE (device_template_id, profile_kind, version);
CREATE UNIQUE INDEX idx_device_template_profiles_active_unique
  ON public.device_template_profiles (device_template_id, profile_kind) WHERE is_active = true;

-- ============================================================
-- 1.6 model_runs: add home_id, device_snapshot, profile_snapshot
-- ============================================================
DROP POLICY IF EXISTS "Customers read/write own model_runs" ON public.model_runs;
DROP POLICY IF EXISTS "Staff full access model_runs" ON public.model_runs;

ALTER TABLE public.model_runs
  ADD COLUMN home_id uuid NULL REFERENCES public.homes(id) ON DELETE CASCADE,
  ADD COLUMN device_snapshot jsonb NOT NULL DEFAULT '[]'::jsonb,
  ADD COLUMN profile_snapshot jsonb NOT NULL DEFAULT '{}'::jsonb;

ALTER TABLE public.model_runs DROP CONSTRAINT IF EXISTS model_runs_energy_home_settings_id_fkey;
ALTER TABLE public.model_runs DROP COLUMN IF EXISTS energy_home_settings_id;

CREATE POLICY "Staff full access model_runs"
  ON public.model_runs FOR ALL USING (public.is_staff(auth.uid()));
CREATE POLICY "Customers view own model runs"
  ON public.model_runs FOR SELECT
  USING (EXISTS (SELECT 1 FROM public.homes h WHERE h.id = home_id AND h.customer_id = public.get_customer_id_for_user(auth.uid())));
CREATE POLICY "Customers insert own model runs"
  ON public.model_runs FOR INSERT
  WITH CHECK (EXISTS (SELECT 1 FROM public.homes h WHERE h.id = home_id AND h.customer_id = public.get_customer_id_for_user(auth.uid())));
