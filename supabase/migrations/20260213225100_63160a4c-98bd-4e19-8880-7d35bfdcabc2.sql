
-- ============================================================
-- Phase 0: Add semantic_key to home_questions
-- ============================================================
ALTER TABLE public.home_questions ADD COLUMN IF NOT EXISTS semantic_key text;

UPDATE public.home_questions SET semantic_key = 'dwelling_type' WHERE id = 'ab21a757-053f-42d8-ab53-84316830f20f';
UPDATE public.home_questions SET semantic_key = 'occupants' WHERE id = 'a0c4f225-47e9-49ed-acea-21e8fb79c818';
UPDATE public.home_questions SET semantic_key = 'year_built' WHERE id = 'd0b1812c-f5f3-4ba0-bc1b-e18112742cb3';
UPDATE public.home_questions SET semantic_key = 'heated_area_m2' WHERE id = 'd1d8c131-b069-499e-af50-f3f3e25c38a1';
UPDATE public.home_questions SET semantic_key = 'ev_charger_power_kw' WHERE id = '1c2e6e05-1e18-4729-91f3-c7db90e284f5';
UPDATE public.home_questions SET semantic_key = 'has_solar' WHERE id = '9801c4a7-398f-4e35-a28e-ffad844b27ed';
UPDATE public.home_questions SET semantic_key = 'battery_capacity_kwh' WHERE id = '485c881a-ae3c-48ef-84e0-9ed57036d950';
UPDATE public.home_questions SET semantic_key = 'has_battery' WHERE id = '93865a93-e49c-47f2-82a4-62a51c7c3bc1';
UPDATE public.home_questions SET semantic_key = 'has_ev' WHERE id = '094916f7-0905-4c20-9c37-c33bb7f66910';
UPDATE public.home_questions SET semantic_key = 'heating_types' WHERE id = '777a76f1-88b4-4b84-8b41-067b4ec419f3';
UPDATE public.home_questions SET semantic_key = 'hot_water_type' WHERE id = '14261263-f2e2-4ef0-bd11-4d9823fe9755';
UPDATE public.home_questions SET semantic_key = 'contract_type' WHERE id = '95ac7f5d-8bd0-4d10-922b-3443b9a16585';
UPDATE public.home_questions SET semantic_key = 'annual_kwh' WHERE id = 'd4962d4a-d43a-47e2-8566-2ba8387d9050';
UPDATE public.home_questions SET semantic_key = 'annual_peak_kw' WHERE id = 'd217fe62-9e59-4780-b0f3-517e8a720ccb';

CREATE UNIQUE INDEX IF NOT EXISTS idx_home_questions_semantic_key ON public.home_questions (semantic_key) WHERE semantic_key IS NOT NULL;

-- ============================================================
-- Phase 1: Energy Modeling tables
-- ============================================================

-- 1. energy_home_settings
CREATE TABLE public.energy_home_settings (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  customer_id uuid NOT NULL REFERENCES public.customers(id) ON DELETE CASCADE,
  overrides jsonb NOT NULL DEFAULT '{}',
  derived jsonb NOT NULL DEFAULT '{}',
  ua_w_per_k numeric,
  thermal_capacity_class text,
  tariff_instance_id uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(customer_id)
);

ALTER TABLE public.energy_home_settings ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Staff full access energy_home_settings"
  ON public.energy_home_settings FOR ALL
  USING (public.is_staff(auth.uid()));

CREATE POLICY "Customers read/write own energy_home_settings"
  ON public.energy_home_settings FOR ALL
  USING (customer_id = public.get_customer_id_for_user(auth.uid()))
  WITH CHECK (customer_id = public.get_customer_id_for_user(auth.uid()));

-- 2. device_templates
CREATE TABLE public.device_templates (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name text NOT NULL,
  category text NOT NULL,
  device_type text NOT NULL,
  max_electrical_power_w integer NOT NULL,
  controllable_default boolean NOT NULL DEFAULT false,
  shiftable_default boolean NOT NULL DEFAULT false,
  scop numeric,
  min_operating_temp_c numeric,
  is_deleted boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT now(),
  created_by uuid
);

ALTER TABLE public.device_templates ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Staff full access device_templates"
  ON public.device_templates FOR ALL
  USING (public.is_staff(auth.uid()));

CREATE POLICY "Customers read device_templates"
  ON public.device_templates FOR SELECT
  USING (auth.uid() IS NOT NULL AND NOT is_deleted);

-- 3. device_template_profiles
CREATE TABLE public.device_template_profiles (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  device_template_id uuid NOT NULL REFERENCES public.device_templates(id) ON DELETE CASCADE,
  version integer NOT NULL DEFAULT 1,
  is_active boolean NOT NULL DEFAULT true,
  profile_kind text NOT NULL,
  resolution_seconds integer NOT NULL DEFAULT 900,
  unit_power text NOT NULL DEFAULT 'W',
  data jsonb NOT NULL DEFAULT '{}',
  source text,
  notes text,
  created_at timestamptz NOT NULL DEFAULT now(),
  created_by uuid
);

ALTER TABLE public.device_template_profiles ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Staff full access device_template_profiles"
  ON public.device_template_profiles FOR ALL
  USING (public.is_staff(auth.uid()));

CREATE POLICY "Customers read device_template_profiles"
  ON public.device_template_profiles FOR SELECT
  USING (auth.uid() IS NOT NULL);

-- 4. energy_devices
CREATE TABLE public.energy_devices (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  energy_home_settings_id uuid NOT NULL REFERENCES public.energy_home_settings(id) ON DELETE CASCADE,
  name text NOT NULL,
  device_template_id uuid NOT NULL REFERENCES public.device_templates(id),
  quantity integer NOT NULL DEFAULT 1,
  max_power_override_w integer,
  controllable boolean NOT NULL DEFAULT false,
  shiftable boolean NOT NULL DEFAULT false,
  priority integer NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE public.energy_devices ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Staff full access energy_devices"
  ON public.energy_devices FOR ALL
  USING (public.is_staff(auth.uid()));

CREATE POLICY "Customers read/write own energy_devices"
  ON public.energy_devices FOR ALL
  USING (
    energy_home_settings_id IN (
      SELECT id FROM public.energy_home_settings
      WHERE customer_id = public.get_customer_id_for_user(auth.uid())
    )
  )
  WITH CHECK (
    energy_home_settings_id IN (
      SELECT id FROM public.energy_home_settings
      WHERE customer_id = public.get_customer_id_for_user(auth.uid())
    )
  );

-- 5. tariff_rules
CREATE TABLE public.tariff_rules (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  provider text NOT NULL,
  name text NOT NULL,
  rule_type text NOT NULL,
  params jsonb NOT NULL DEFAULT '{}',
  effective_from date,
  effective_to date,
  is_active boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE public.tariff_rules ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Staff full access tariff_rules"
  ON public.tariff_rules FOR ALL
  USING (public.is_staff(auth.uid()));

CREATE POLICY "Customers read tariff_rules"
  ON public.tariff_rules FOR SELECT
  USING (auth.uid() IS NOT NULL AND is_active);

-- 6. tariff_instances
CREATE TABLE public.tariff_instances (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  customer_id uuid NOT NULL REFERENCES public.customers(id) ON DELETE CASCADE,
  tariff_rule_id uuid REFERENCES public.tariff_rules(id),
  title text,
  network_price_sek_per_w_month numeric NOT NULL DEFAULT 0.045,
  fixed_monthly_fee_sek numeric NOT NULL DEFAULT 0,
  energy_price_model text NOT NULL DEFAULT 'fixed',
  energy_price_sek_per_kwh numeric NOT NULL DEFAULT 1.0,
  is_active boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE public.tariff_instances ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Staff full access tariff_instances"
  ON public.tariff_instances FOR ALL
  USING (public.is_staff(auth.uid()));

CREATE POLICY "Customers read/write own tariff_instances"
  ON public.tariff_instances FOR ALL
  USING (customer_id = public.get_customer_id_for_user(auth.uid()))
  WITH CHECK (customer_id = public.get_customer_id_for_user(auth.uid()));

-- 7. model_runs
CREATE TABLE public.model_runs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  customer_id uuid NOT NULL REFERENCES public.customers(id) ON DELETE CASCADE,
  energy_home_settings_id uuid REFERENCES public.energy_home_settings(id),
  scenario text NOT NULL,
  mode text NOT NULL,
  step_seconds integer NOT NULL DEFAULT 900,
  inputs_snapshot jsonb NOT NULL DEFAULT '{}',
  tariff_snapshot jsonb NOT NULL DEFAULT '{}',
  results_summary jsonb NOT NULL DEFAULT '{}',
  timeseries jsonb,
  created_at timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE public.model_runs ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Staff full access model_runs"
  ON public.model_runs FOR ALL
  USING (public.is_staff(auth.uid()));

CREATE POLICY "Customers read/write own model_runs"
  ON public.model_runs FOR ALL
  USING (customer_id = public.get_customer_id_for_user(auth.uid()))
  WITH CHECK (customer_id = public.get_customer_id_for_user(auth.uid()));

-- 8. energy_raw_uploads
CREATE TABLE public.energy_raw_uploads (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  uploaded_by uuid NOT NULL,
  house_id uuid,
  device_id uuid,
  template_id uuid,
  file_path text NOT NULL,
  file_type text,
  detected_columns jsonb,
  created_at timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE public.energy_raw_uploads ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Staff full access energy_raw_uploads"
  ON public.energy_raw_uploads FOR ALL
  USING (public.is_staff(auth.uid()));

-- 9. energy_normalized_series
CREATE TABLE public.energy_normalized_series (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  raw_upload_id uuid REFERENCES public.energy_raw_uploads(id) ON DELETE CASCADE,
  series_kind text NOT NULL,
  timezone text NOT NULL DEFAULT 'Europe/Stockholm',
  step_seconds integer NOT NULL DEFAULT 900,
  start_ts timestamptz NOT NULL,
  end_ts timestamptz NOT NULL,
  values_w jsonb NOT NULL DEFAULT '[]',
  quality jsonb,
  created_at timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE public.energy_normalized_series ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Staff full access energy_normalized_series"
  ON public.energy_normalized_series FOR ALL
  USING (public.is_staff(auth.uid()));

-- FK for tariff_instance_id
ALTER TABLE public.energy_home_settings
  ADD CONSTRAINT energy_home_settings_tariff_instance_id_fkey
  FOREIGN KEY (tariff_instance_id) REFERENCES public.tariff_instances(id);

-- ============================================================
-- Seed data
-- ============================================================

-- Device templates
INSERT INTO public.device_templates (name, category, device_type, max_electrical_power_w, controllable_default, shiftable_default, scop, min_operating_temp_c) VALUES
  ('Luft-luft värmepump 12kW', 'heating', 'heat_pump_air_air', 3500, true, false, 3.5, -20),
  ('Elradiator 2kW', 'heating', 'resistive_heater', 2000, true, false, null, null),
  ('Elbilsladdare 11kW', 'ev', 'ev_charger', 11000, true, true, null, null),
  ('Diskmaskin', 'appliance', 'appliance', 2000, false, true, null, null),
  ('Tvättmaskin', 'appliance', 'appliance', 2200, false, true, null, null),
  ('Baslast', 'base_load', 'base_load', 500, false, false, null, null);

-- Heat pump COP profile
INSERT INTO public.device_template_profiles (device_template_id, version, is_active, profile_kind, data, source, notes)
SELECT id, 1, true, 'cop_curve',
  '{"points":[{"temp_c":-20,"cop":1.5,"capacity_w":2000},{"temp_c":-15,"cop":1.8,"capacity_w":2500},{"temp_c":-10,"cop":2.2,"capacity_w":3000},{"temp_c":-5,"cop":2.7,"capacity_w":3500},{"temp_c":0,"cop":3.2,"capacity_w":4000},{"temp_c":5,"cop":3.8,"capacity_w":5000},{"temp_c":7,"cop":4.0,"capacity_w":5500},{"temp_c":10,"cop":4.3,"capacity_w":6000},{"temp_c":15,"cop":4.8,"capacity_w":7000}]}'::jsonb,
  'manufacturer_typical', 'Typical air-air heat pump COP/capacity curve'
FROM public.device_templates WHERE device_type = 'heat_pump_air_air' LIMIT 1;

-- Ellevio villa tariff rule
INSERT INTO public.tariff_rules (provider, name, rule_type, params, is_active) VALUES
  ('Ellevio', 'Villa effekttariff', 'peak_demand',
   '{"peak_method":"top_3_daily","night_factor":0.5,"night_hours":[22,23,0,1,2,3,4,5],"base_price_sek_per_w_month":0.045}'::jsonb,
   true);

-- ============================================================
-- Storage bucket for energy raw uploads
-- ============================================================
INSERT INTO storage.buckets (id, name, public) VALUES ('energy-raw-uploads', 'energy-raw-uploads', false)
ON CONFLICT (id) DO NOTHING;

CREATE POLICY "Staff upload energy raw files"
  ON storage.objects FOR INSERT
  WITH CHECK (bucket_id = 'energy-raw-uploads' AND public.is_staff(auth.uid()));

CREATE POLICY "Staff read energy raw files"
  ON storage.objects FOR SELECT
  USING (bucket_id = 'energy-raw-uploads' AND public.is_staff(auth.uid()));

CREATE POLICY "Staff delete energy raw files"
  ON storage.objects FOR DELETE
  USING (bucket_id = 'energy-raw-uploads' AND public.is_staff(auth.uid()));

-- Updated_at triggers
CREATE TRIGGER update_energy_home_settings_updated_at
  BEFORE UPDATE ON public.energy_home_settings
  FOR EACH ROW EXECUTE FUNCTION public.update_simple_updated_at();

CREATE TRIGGER update_energy_devices_updated_at
  BEFORE UPDATE ON public.energy_devices
  FOR EACH ROW EXECUTE FUNCTION public.update_simple_updated_at();
