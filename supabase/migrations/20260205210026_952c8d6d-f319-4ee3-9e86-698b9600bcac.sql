-- Drop the trigger that auto-generates quote numbers on insert
DROP TRIGGER IF EXISTS set_quote_number ON public.quotes;

-- Drop the function that generates quote numbers
DROP FUNCTION IF EXISTS public.generate_quote_number();