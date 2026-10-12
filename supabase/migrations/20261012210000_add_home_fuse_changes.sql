-- Actual fuse change dates are supplied by the homeowner, never inferred from
-- a questionnaire edit timestamp. The questionnaire remains the current fact.
CREATE TABLE public.home_fuse_changes (
  home_id uuid NOT NULL REFERENCES public.homes(id) ON DELETE CASCADE,
  changed_on date NOT NULL,
  previous_fuse_a integer NOT NULL CHECK (previous_fuse_a IN (16,20,25,35,50,63)),
  PRIMARY KEY (home_id, changed_on)
);
ALTER TABLE public.home_fuse_changes ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Read accessible home fuse history" ON public.home_fuse_changes
  FOR SELECT TO authenticated USING (EXISTS (
    SELECT 1 FROM public.homes h WHERE h.id = home_id
      AND public.can_access_energy_billing_customer(h.customer_id)
  ));
REVOKE ALL ON public.home_fuse_changes FROM PUBLIC, anon, authenticated;
GRANT SELECT ON public.home_fuse_changes TO authenticated;
GRANT ALL ON public.home_fuse_changes TO service_role;

CREATE FUNCTION public.record_home_fuse_change(p_home_id uuid, p_changed_on date, p_previous_fuse_a integer)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM public.homes h WHERE h.id = p_home_id AND (
    auth.role() = 'service_role' OR public.can_access_energy_billing_customer(h.customer_id)
  )) THEN
    RAISE EXCEPTION 'Home fuse history access denied' USING ERRCODE = '42501';
  END IF;
  INSERT INTO public.home_fuse_changes(home_id, changed_on, previous_fuse_a)
    VALUES (p_home_id, p_changed_on, p_previous_fuse_a)
    ON CONFLICT (home_id, changed_on) DO UPDATE SET previous_fuse_a = EXCLUDED.previous_fuse_a;
END;
$$;
REVOKE ALL ON FUNCTION public.record_home_fuse_change(uuid,date,integer) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.record_home_fuse_change(uuid,date,integer) TO authenticated, service_role;
