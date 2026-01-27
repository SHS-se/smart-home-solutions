-- Drop the incompatible trigger
DROP TRIGGER IF EXISTS update_sku_categories_updated_at ON public.sku_categories;

-- Create a simpler function for just updating updated_at
CREATE OR REPLACE FUNCTION public.update_simple_updated_at()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public
AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$;

-- Add the new trigger
CREATE TRIGGER update_sku_categories_updated_at
  BEFORE UPDATE ON public.sku_categories
  FOR EACH ROW
  EXECUTE FUNCTION public.update_simple_updated_at();