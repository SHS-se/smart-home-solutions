-- Create helper function to set app environment at session level
CREATE OR REPLACE FUNCTION public.set_app_environment(env TEXT)
RETURNS void AS $$
BEGIN
  PERFORM set_config('app.environment', env, true);
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public';

-- Update quote number generator to use environment-aware prefixes
CREATE OR REPLACE FUNCTION public.generate_quote_number()
RETURNS TRIGGER AS $$
DECLARE
  next_num INTEGER;
  prefix TEXT;
  app_env TEXT;
BEGIN
  -- Get environment from application setting (set per deployment)
  app_env := current_setting('app.environment', true);
  
  -- Determine prefix based on environment
  IF app_env = 'live' THEN
    prefix := 'Q-';
  ELSE
    prefix := 'TQ-';
  END IF;
  
  -- Get the next number for THIS prefix only
  SELECT COALESCE(MAX(
    CASE 
      WHEN quote_number ~ ('^' || prefix || '\d+$') 
      THEN CAST(SUBSTRING(quote_number FROM LENGTH(prefix) + 1) AS INTEGER)
      ELSE 0
    END
  ), 0) + 1
  INTO next_num
  FROM public.quotes
  WHERE quote_number LIKE prefix || '%';
  
  -- Set the quote number with 8-digit padding
  NEW.quote_number := prefix || LPAD(next_num::TEXT, 8, '0');
  
  RETURN NEW;
END;
$$ LANGUAGE plpgsql SET search_path TO 'public';