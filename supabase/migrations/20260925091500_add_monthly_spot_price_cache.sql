CREATE TABLE public.energy_monthly_spot_prices (
  area text NOT NULL CHECK (area IN ('SE1', 'SE2', 'SE3', 'SE4')),
  month date NOT NULL CHECK (extract(day FROM month) = 1),
  through_date date NOT NULL,
  average_sek_ex_vat numeric NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (area, month)
);
ALTER TABLE public.energy_monthly_spot_prices ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.energy_monthly_spot_prices FROM PUBLIC, anon, authenticated;
GRANT ALL ON public.energy_monthly_spot_prices TO service_role;
COMMENT ON TABLE public.energy_monthly_spot_prices IS
  'Time-weighted market averages from elprisetjustnu.se. Full months are immutable; the current month is refreshed through yesterday.';
