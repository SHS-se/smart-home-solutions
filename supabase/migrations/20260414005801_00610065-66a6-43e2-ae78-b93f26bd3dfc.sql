CREATE UNIQUE INDEX uq_acc_verifications_source
  ON public.acc_verifications (source_type, source_id)
  WHERE source_id IS NOT NULL;