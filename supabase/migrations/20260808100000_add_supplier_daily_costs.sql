-- The grid tariff never covers the energy itself, so a Home Assistant push
-- could describe elnät exactly and elhandel not at all. The integration now
-- values each hour's grid energy at that hour's supplier price and sends the
-- daily result, which lets the portal estimate a supplier bill for every month
-- the customer has not uploaded one.
CREATE TABLE public.energy_supplier_daily_costs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  customer_id uuid NOT NULL REFERENCES public.customers(id) ON DELETE CASCADE,
  cost_date date NOT NULL,
  import_kwh numeric NOT NULL CHECK (import_kwh >= 0),
  import_cost_sek numeric NOT NULL,
  export_kwh numeric NOT NULL DEFAULT 0 CHECK (export_kwh >= 0),
  export_credit_sek numeric NOT NULL DEFAULT 0,
  -- How many of the day's hours carried a quoted price. Below 24 (23 or 25 on
  -- the DST changeover days) the day is priced on partial data.
  priced_hours integer NOT NULL CHECK (priced_hours BETWEEN 0 AND 25),
  device_token_id uuid REFERENCES public.ha_device_tokens(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (customer_id, cost_date)
);

CREATE INDEX idx_energy_supplier_daily_costs_customer_date
  ON public.energy_supplier_daily_costs (customer_id, cost_date);

CREATE TRIGGER energy_supplier_daily_costs_updated_at
  BEFORE UPDATE ON public.energy_supplier_daily_costs
  FOR EACH ROW
  EXECUTE FUNCTION public.update_simple_updated_at();

ALTER TABLE public.energy_supplier_daily_costs ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Energy subscribers read own supplier daily costs"
  ON public.energy_supplier_daily_costs
  FOR SELECT
  TO authenticated
  USING (public.can_access_energy_billing_customer(customer_id));

REVOKE ALL ON public.energy_supplier_daily_costs FROM PUBLIC, anon, authenticated;
GRANT SELECT ON public.energy_supplier_daily_costs TO authenticated;
