-- Independently published server forecasts: planning admission reads and aligns
-- one product rather than reading history, fetching weather or fitting models.
CREATE TABLE public.energy_prepared_forecasts (
  home_id uuid PRIMARY KEY REFERENCES public.homes(id) ON DELETE CASCADE,
  issued_at timestamptz NOT NULL DEFAULT now(),
  forecast jsonb NOT NULL CHECK (jsonb_typeof(forecast) = 'object')
);
ALTER TABLE public.energy_prepared_forecasts ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.energy_prepared_forecasts FROM PUBLIC, anon, authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.energy_prepared_forecasts TO service_role;
COMMENT ON TABLE public.energy_prepared_forecasts IS
  'Model-owned server forecast publication: slot timestamps, price outlook, weather and thermal-zone forecasts. Only background producers write; planning admission reads.';

-- Physical thermostat configuration belongs to the equipment, independently
-- of portal comfort preferences and fitted heat-transfer coefficients.
ALTER TABLE public.energy_optimisation_pool_model ADD COLUMN hardware jsonb;
COMMENT ON COLUMN public.energy_optimisation_pool_model.hardware IS
  'Published equipment settings and their source entity IDs, separate from customer comfort targets; preserved by thermal-model refits.';
