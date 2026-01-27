-- Create sku_categories table
CREATE TABLE public.sku_categories (
  id uuid NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  name text NOT NULL UNIQUE,
  description text,
  sort_order integer NOT NULL DEFAULT 0,
  created_at timestamp with time zone NOT NULL DEFAULT now(),
  updated_at timestamp with time zone NOT NULL DEFAULT now()
);

-- Enable RLS
ALTER TABLE public.sku_categories ENABLE ROW LEVEL SECURITY;

-- Staff-only policies
CREATE POLICY "Staff can view sku_categories" ON public.sku_categories FOR SELECT USING (is_staff(auth.uid()));
CREATE POLICY "Staff can insert sku_categories" ON public.sku_categories FOR INSERT WITH CHECK (is_staff(auth.uid()));
CREATE POLICY "Staff can update sku_categories" ON public.sku_categories FOR UPDATE USING (is_staff(auth.uid()));
CREATE POLICY "Staff can delete sku_categories" ON public.sku_categories FOR DELETE USING (is_staff(auth.uid()));

-- Add trigger for updated_at
CREATE TRIGGER update_sku_categories_updated_at
  BEFORE UPDATE ON public.sku_categories
  FOR EACH ROW
  EXECUTE FUNCTION public.update_updated_at_column();

-- Seed with existing categories
INSERT INTO public.sku_categories (name, sort_order) VALUES
  ('Sensorer', 1),
  ('Controllers', 2),
  ('Reläer', 3),
  ('Material', 4),
  ('Tjänst', 5);