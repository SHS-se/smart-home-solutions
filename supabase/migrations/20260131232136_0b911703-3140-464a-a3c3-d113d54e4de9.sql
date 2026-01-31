-- Fix the generate_quote_number function to set search_path
CREATE OR REPLACE FUNCTION public.generate_quote_number()
RETURNS TRIGGER AS $$
DECLARE
  next_num INTEGER;
BEGIN
  -- Get the next number based on existing quote numbers
  SELECT COALESCE(MAX(
    CASE 
      WHEN quote_number ~ '^Q-\d+$' THEN CAST(SUBSTRING(quote_number FROM 3) AS INTEGER)
      ELSE 0
    END
  ), 0) + 1
  INTO next_num
  FROM public.quotes;
  
  -- Set the quote number with 8-digit padding
  NEW.quote_number := 'Q-' || LPAD(next_num::TEXT, 8, '0');
  
  RETURN NEW;
END;
$$ LANGUAGE plpgsql
SET search_path TO 'public';