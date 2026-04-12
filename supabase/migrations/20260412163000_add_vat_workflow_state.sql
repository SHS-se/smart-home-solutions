alter table public.acc_vat_periods
  add column workflow_state jsonb not null default '{}'::jsonb;
