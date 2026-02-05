
-- Auto-assign quote_number on insert via trigger
CREATE OR REPLACE FUNCTION public.auto_assign_quote_number()
  RETURNS trigger
  LANGUAGE plpgsql
  SECURITY DEFINER
  SET search_path TO 'public'
AS $function$
DECLARE
  v_number text;
BEGIN
  -- Only assign if not already set
  IF NEW.quote_number IS NULL THEN
    -- Set environment for prefix determination
    PERFORM public.set_app_environment(
      COALESCE(current_setting('app.environment', true), 'sandbox')
    );
    SELECT public.generate_next_quote_number() INTO v_number;
    NEW.quote_number := v_number;
  END IF;
  RETURN NEW;
END;
$function$;

CREATE TRIGGER trg_auto_assign_quote_number
  BEFORE INSERT ON public.quotes
  FOR EACH ROW
  EXECUTE FUNCTION public.auto_assign_quote_number();
