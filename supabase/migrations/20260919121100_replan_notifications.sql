-- Only the server-side device-authenticated wait endpoint reads this private topic.
-- No plan, snapshot or customer data is broadcast.
CREATE FUNCTION public.notify_energy_replan() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
BEGIN
  PERFORM realtime.send(jsonb_build_object('request_id', NEW.replan_request_id),
    'requested', 'shs-replan:' || NEW.home_id::text, true);
  RETURN NEW;
END;
$$;
REVOKE ALL ON FUNCTION public.notify_energy_replan() FROM PUBLIC;
CREATE TRIGGER energy_replan_requested
  AFTER UPDATE OF replan_request_id ON public.energy_optimisation_current
  FOR EACH ROW WHEN (NEW.replan_request_id IS NOT NULL
    AND NEW.replan_request_id IS DISTINCT FROM OLD.replan_request_id)
  EXECUTE FUNCTION public.notify_energy_replan();
