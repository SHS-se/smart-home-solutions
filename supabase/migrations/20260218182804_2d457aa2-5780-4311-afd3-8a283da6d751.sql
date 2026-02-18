
-- 1a. Create device_types table
CREATE TABLE public.device_types (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  key text UNIQUE NOT NULL,
  display_name text NOT NULL,
  field_schema jsonb NOT NULL,
  supported_profile_kinds jsonb NOT NULL DEFAULT '[]'::jsonb,
  simulation_model_key text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE public.device_types ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Staff full access device_types"
  ON public.device_types FOR ALL
  USING (is_staff(auth.uid()));

CREATE POLICY "Customers read device_types"
  ON public.device_types FOR SELECT
  USING (auth.uid() IS NOT NULL);

-- 1b. Seed initial device types
INSERT INTO public.device_types (key, display_name, field_schema, supported_profile_kinds, simulation_model_key) VALUES
('air_to_air_heat_pump', 'Air-Air Heat Pump', '{"fields":[{"key":"make","type":"text","required":true,"label":"Make"},{"key":"model","type":"text","required":true,"label":"Model"},{"key":"max_power_w","type":"number","required":true,"label":"Max Power (W)"},{"key":"scop","type":"number","required":true,"label":"SCOP"},{"key":"cop","type":"number","required":false,"label":"COP"},{"key":"min_temp_c","type":"number","required":false,"label":"Min Temp (°C)"}]}', '["cop_curve","capacity_curve"]', 'heat_pump_aa'),
('direct_electric_heater', 'Electric Heater', '{"fields":[{"key":"make","type":"text","required":true,"label":"Make"},{"key":"model","type":"text","required":true,"label":"Model"},{"key":"max_power_w","type":"number","required":true,"label":"Max Power (W)"}]}', '[]', 'resistive'),
('ev_charger', 'EV Charger', '{"fields":[{"key":"make","type":"text","required":true,"label":"Make"},{"key":"model","type":"text","required":true,"label":"Model"},{"key":"max_power_w","type":"number","required":true,"label":"Max Power (W)"}]}', '[]', 'ev_charger'),
('appliance', 'Appliance', '{"fields":[{"key":"make","type":"text","required":true,"label":"Make"},{"key":"model","type":"text","required":true,"label":"Model"},{"key":"max_power_w","type":"number","required":true,"label":"Max Power (W)"}]}', '[]', 'fixed_schedule'),
('base_load', 'Base Load', '{"fields":[{"key":"make","type":"text","required":true,"label":"Make"},{"key":"model","type":"text","required":true,"label":"Model"},{"key":"max_power_w","type":"number","required":true,"label":"Max Power (W)"}]}', '[]', 'constant'),
('hot_water_heater', 'Hot Water Heater', '{"fields":[{"key":"make","type":"text","required":true,"label":"Make"},{"key":"model","type":"text","required":true,"label":"Model"},{"key":"max_power_w","type":"number","required":true,"label":"Max Power (W)"}]}', '[]', 'hot_water');

-- 1c. Add device_type_id FK to device_templates
ALTER TABLE public.device_templates
  ADD COLUMN device_type_id uuid REFERENCES public.device_types(id);

ALTER TABLE public.device_templates
  ADD COLUMN field_defaults jsonb NOT NULL DEFAULT '{}'::jsonb;

-- Backfill device_type_id from device_kind
UPDATE public.device_templates dt
SET device_type_id = dty.id
FROM public.device_types dty
WHERE dt.device_kind = dty.key;

-- Make NOT NULL after backfill
ALTER TABLE public.device_templates
  ALTER COLUMN device_type_id SET NOT NULL;

-- 1d. Create device_instances table
CREATE TABLE public.device_instances (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  home_id uuid NOT NULL REFERENCES public.homes(id) ON DELETE CASCADE,
  device_template_id uuid NOT NULL REFERENCES public.device_templates(id),
  name text NOT NULL,
  quantity integer NOT NULL DEFAULT 1,
  field_values jsonb NOT NULL DEFAULT '{}'::jsonb,
  controllable boolean NOT NULL DEFAULT false,
  shiftable boolean NOT NULL DEFAULT false,
  priority integer NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE public.device_instances ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Staff full access device_instances"
  ON public.device_instances FOR ALL
  USING (is_staff(auth.uid()));

CREATE POLICY "Customers view own device_instances"
  ON public.device_instances FOR SELECT
  USING (EXISTS (SELECT 1 FROM homes h WHERE h.id = device_instances.home_id AND h.customer_id = get_customer_id_for_user(auth.uid())));

CREATE POLICY "Customers insert own device_instances"
  ON public.device_instances FOR INSERT
  WITH CHECK (EXISTS (SELECT 1 FROM homes h WHERE h.id = device_instances.home_id AND h.customer_id = get_customer_id_for_user(auth.uid())));

CREATE POLICY "Customers update own device_instances"
  ON public.device_instances FOR UPDATE
  USING (EXISTS (SELECT 1 FROM homes h WHERE h.id = device_instances.home_id AND h.customer_id = get_customer_id_for_user(auth.uid())));

CREATE POLICY "Customers delete own device_instances"
  ON public.device_instances FOR DELETE
  USING (EXISTS (SELECT 1 FROM homes h WHERE h.id = device_instances.home_id AND h.customer_id = get_customer_id_for_user(auth.uid())));

-- Updated_at trigger
CREATE TRIGGER update_device_instances_updated_at
  BEFORE UPDATE ON public.device_instances
  FOR EACH ROW
  EXECUTE FUNCTION public.update_simple_updated_at();

-- 1e. Migrate energy_devices → device_instances (preserve IDs)
INSERT INTO public.device_instances (id, home_id, device_template_id, name, quantity, field_values, controllable, shiftable, priority, created_at, updated_at)
SELECT
  ed.id,
  ed.home_id,
  ed.device_template_id,
  ed.name,
  ed.quantity,
  jsonb_build_object(
    'make', dt.make,
    'model', dt.model,
    'max_power_w', COALESCE(ed.max_power_override_w, dt.max_electrical_power_w)
  ) || CASE WHEN dt.scop IS NOT NULL THEN jsonb_build_object('scop', dt.scop) ELSE '{}'::jsonb END
    || CASE WHEN dt.min_operating_temp_c IS NOT NULL THEN jsonb_build_object('min_temp_c', dt.min_operating_temp_c) ELSE '{}'::jsonb END,
  ed.controllable,
  ed.shiftable,
  ed.priority,
  ed.created_at,
  ed.updated_at
FROM public.energy_devices ed
JOIN public.device_templates dt ON dt.id = ed.device_template_id;
