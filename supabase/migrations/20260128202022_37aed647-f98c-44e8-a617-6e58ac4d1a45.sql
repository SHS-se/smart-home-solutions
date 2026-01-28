-- =============================================
-- Phase 1: Schema Changes
-- =============================================

-- 1.1 Extend skus table with VAT-aware pricing columns
ALTER TABLE public.skus
ADD COLUMN IF NOT EXISTS purchase_price numeric NOT NULL DEFAULT 0,
ADD COLUMN IF NOT EXISTS purchase_includes_vat boolean NOT NULL DEFAULT false,
ADD COLUMN IF NOT EXISTS vat_rate numeric NOT NULL DEFAULT 0.25,
ADD COLUMN IF NOT EXISTS cost_ex_vat_computed numeric,
ADD COLUMN IF NOT EXISTS margin_override_percent numeric,
ADD COLUMN IF NOT EXISTS rounding_override_sek integer,
ADD COLUMN IF NOT EXISTS effective_margin_percent numeric,
ADD COLUMN IF NOT EXISTS effective_rounding_sek integer,
ADD COLUMN IF NOT EXISTS sell_price_ex_vat numeric,
ADD COLUMN IF NOT EXISTS sell_price_inc_vat numeric,
ADD COLUMN IF NOT EXISTS pricing_updated_at timestamptz;

-- 1.2 Create sku_price_history table
CREATE TABLE IF NOT EXISTS public.sku_price_history (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  sku_id uuid NOT NULL REFERENCES public.skus(id) ON DELETE CASCADE,
  changed_at timestamptz NOT NULL DEFAULT now(),
  changed_by uuid,
  change_reason text NOT NULL,
  purchase_price numeric NOT NULL,
  purchase_includes_vat boolean NOT NULL,
  vat_rate numeric NOT NULL,
  cost_ex_vat numeric NOT NULL,
  category text NOT NULL,
  margin_override_percent numeric,
  rounding_override_sek integer,
  rule_margin_percent numeric NOT NULL,
  rule_rounding_sek integer NOT NULL,
  effective_margin_percent numeric NOT NULL,
  effective_rounding_sek integer NOT NULL,
  sell_price_ex_vat numeric NOT NULL,
  sell_price_inc_vat numeric NOT NULL
);

-- RLS for sku_price_history
ALTER TABLE public.sku_price_history ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Staff can view sku_price_history"
  ON public.sku_price_history FOR SELECT
  USING (is_staff(auth.uid()));

CREATE POLICY "Staff can insert sku_price_history"
  ON public.sku_price_history FOR INSERT
  WITH CHECK (is_staff(auth.uid()));

-- 1.3 Extend bom_items table
ALTER TABLE public.bom_items
ADD COLUMN IF NOT EXISTS cost_ex_vat_at_time numeric,
ADD COLUMN IF NOT EXISTS sell_price_ex_vat_at_time numeric,
ADD COLUMN IF NOT EXISTS vat_rate_at_time numeric DEFAULT 0.25,
ADD COLUMN IF NOT EXISTS sell_price_inc_vat_at_time numeric,
ADD COLUMN IF NOT EXISTS pricing_source text DEFAULT 'sku';

-- Migrate existing data in bom_items
UPDATE public.bom_items 
SET cost_ex_vat_at_time = cost,
    sell_price_ex_vat_at_time = sell_price
WHERE cost_ex_vat_at_time IS NULL AND cost IS NOT NULL;

-- 1.4 Extend quote_lines table
ALTER TABLE public.quote_lines
ADD COLUMN IF NOT EXISTS sku_id uuid REFERENCES public.skus(id) ON DELETE SET NULL,
ADD COLUMN IF NOT EXISTS unit_price_ex_vat numeric,
ADD COLUMN IF NOT EXISTS vat_rate numeric DEFAULT 0.25,
ADD COLUMN IF NOT EXISTS unit_price_inc_vat numeric,
ADD COLUMN IF NOT EXISTS cost_ex_vat_at_time numeric,
ADD COLUMN IF NOT EXISTS original_sku_name text,
ADD COLUMN IF NOT EXISTS original_sku_code text,
ADD COLUMN IF NOT EXISTS pricing_source text DEFAULT 'sku';

-- Migrate existing data in quote_lines
UPDATE public.quote_lines
SET unit_price_ex_vat = unit_price
WHERE unit_price_ex_vat IS NULL AND unit_price IS NOT NULL;

-- 1.5 Extend quotes table
ALTER TABLE public.quotes
ADD COLUMN IF NOT EXISTS subtotal_ex_vat numeric DEFAULT 0,
ADD COLUMN IF NOT EXISTS vat_total numeric DEFAULT 0,
ADD COLUMN IF NOT EXISTS total_inc_vat numeric DEFAULT 0;

-- =============================================
-- Phase 2: Functions and Triggers
-- =============================================

-- 2.1 Helper function to compute pricing (returns record)
CREATE OR REPLACE FUNCTION public.sku_compute_pricing(
  p_purchase_price numeric,
  p_purchase_includes_vat boolean,
  p_vat_rate numeric,
  p_category text,
  p_margin_override_percent numeric,
  p_rounding_override_sek integer
)
RETURNS TABLE (
  cost_ex_vat_computed numeric,
  effective_margin_percent numeric,
  effective_rounding_sek integer,
  rule_margin_percent numeric,
  rule_rounding_sek integer,
  sell_price_ex_vat numeric,
  sell_price_inc_vat numeric
)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_cost_ex_vat numeric;
  v_rule_margin numeric;
  v_rule_rounding integer;
  v_effective_margin numeric;
  v_effective_rounding integer;
  v_raw_price numeric;
  v_sell_ex_vat numeric;
  v_sell_inc_vat numeric;
BEGIN
  -- Compute cost ex VAT
  IF p_purchase_includes_vat THEN
    v_cost_ex_vat := p_purchase_price / (1 + p_vat_rate);
  ELSE
    v_cost_ex_vat := p_purchase_price;
  END IF;

  -- Look up category margin rules
  SELECT mr.margin_percent, mr.rounding
  INTO v_rule_margin, v_rule_rounding
  FROM public.margin_rules mr
  WHERE mr.category = p_category;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Category "%" not found in margin_rules', p_category;
  END IF;

  -- Resolve effective values
  v_effective_margin := COALESCE(p_margin_override_percent, v_rule_margin);
  v_effective_rounding := COALESCE(p_rounding_override_sek, v_rule_rounding);

  IF v_effective_rounding < 1 THEN
    RAISE EXCEPTION 'Rounding must be >= 1, got %', v_effective_rounding;
  END IF;

  -- Calculate sell prices with CEILING rounding
  v_raw_price := v_cost_ex_vat * (1 + v_effective_margin / 100);
  v_sell_ex_vat := CEILING(v_raw_price / v_effective_rounding) * v_effective_rounding;
  v_sell_inc_vat := v_sell_ex_vat * (1 + p_vat_rate);

  RETURN QUERY SELECT
    v_cost_ex_vat,
    v_effective_margin,
    v_effective_rounding,
    v_rule_margin,
    v_rule_rounding,
    v_sell_ex_vat,
    v_sell_inc_vat;
END;
$$;

-- 2.2 BEFORE trigger to compute pricing on SKU insert/update
CREATE OR REPLACE FUNCTION public.sku_pricing_before_trigger()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_pricing RECORD;
BEGIN
  -- Only recalculate if pricing-affecting fields changed
  IF TG_OP = 'INSERT' OR
     NEW.purchase_price IS DISTINCT FROM OLD.purchase_price OR
     NEW.purchase_includes_vat IS DISTINCT FROM OLD.purchase_includes_vat OR
     NEW.vat_rate IS DISTINCT FROM OLD.vat_rate OR
     NEW.category IS DISTINCT FROM OLD.category OR
     NEW.margin_override_percent IS DISTINCT FROM OLD.margin_override_percent OR
     NEW.rounding_override_sek IS DISTINCT FROM OLD.rounding_override_sek
  THEN
    -- Compute pricing
    SELECT * INTO v_pricing
    FROM public.sku_compute_pricing(
      NEW.purchase_price,
      NEW.purchase_includes_vat,
      NEW.vat_rate,
      NEW.category,
      NEW.margin_override_percent,
      NEW.rounding_override_sek
    );

    -- Assign computed values to NEW
    NEW.cost_ex_vat_computed := v_pricing.cost_ex_vat_computed;
    NEW.effective_margin_percent := v_pricing.effective_margin_percent;
    NEW.effective_rounding_sek := v_pricing.effective_rounding_sek;
    NEW.sell_price_ex_vat := v_pricing.sell_price_ex_vat;
    NEW.sell_price_inc_vat := v_pricing.sell_price_inc_vat;
    NEW.pricing_updated_at := now();
  END IF;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS sku_pricing_before ON public.skus;
CREATE TRIGGER sku_pricing_before
  BEFORE INSERT OR UPDATE ON public.skus
  FOR EACH ROW
  EXECUTE FUNCTION public.sku_pricing_before_trigger();

-- 2.3 SECURITY DEFINER function for history insert (bypasses RLS)
CREATE OR REPLACE FUNCTION public.sku_insert_price_history(
  p_sku_id uuid,
  p_change_reason text,
  p_purchase_price numeric,
  p_purchase_includes_vat boolean,
  p_vat_rate numeric,
  p_cost_ex_vat numeric,
  p_category text,
  p_margin_override_percent numeric,
  p_rounding_override_sek integer,
  p_rule_margin_percent numeric,
  p_rule_rounding_sek integer,
  p_effective_margin_percent numeric,
  p_effective_rounding_sek integer,
  p_sell_price_ex_vat numeric,
  p_sell_price_inc_vat numeric
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  INSERT INTO public.sku_price_history (
    sku_id, changed_at, changed_by, change_reason,
    purchase_price, purchase_includes_vat, vat_rate, cost_ex_vat, category,
    margin_override_percent, rounding_override_sek,
    rule_margin_percent, rule_rounding_sek,
    effective_margin_percent, effective_rounding_sek,
    sell_price_ex_vat, sell_price_inc_vat
  ) VALUES (
    p_sku_id, now(), auth.uid(), p_change_reason,
    p_purchase_price, p_purchase_includes_vat, p_vat_rate, p_cost_ex_vat, p_category,
    p_margin_override_percent, p_rounding_override_sek,
    p_rule_margin_percent, p_rule_rounding_sek,
    p_effective_margin_percent, p_effective_rounding_sek,
    p_sell_price_ex_vat, p_sell_price_inc_vat
  );
END;
$$;

-- 2.3 AFTER trigger to insert history
CREATE OR REPLACE FUNCTION public.sku_pricing_after_trigger()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_pricing RECORD;
  v_reason text;
BEGIN
  -- Only log if pricing-affecting fields changed
  IF TG_OP = 'INSERT' THEN
    v_reason := 'sku created';
  ELSIF NEW.purchase_price IS DISTINCT FROM OLD.purchase_price OR
        NEW.purchase_includes_vat IS DISTINCT FROM OLD.purchase_includes_vat OR
        NEW.vat_rate IS DISTINCT FROM OLD.vat_rate OR
        NEW.category IS DISTINCT FROM OLD.category OR
        NEW.margin_override_percent IS DISTINCT FROM OLD.margin_override_percent OR
        NEW.rounding_override_sek IS DISTINCT FROM OLD.rounding_override_sek
  THEN
    v_reason := 'pricing fields updated';
  ELSE
    RETURN NEW;
  END IF;

  -- Get rule values for history
  SELECT mr.margin_percent, mr.rounding
  INTO v_pricing
  FROM public.margin_rules mr
  WHERE mr.category = NEW.category;

  -- Insert history using SECURITY DEFINER function
  PERFORM public.sku_insert_price_history(
    NEW.id,
    v_reason,
    NEW.purchase_price,
    NEW.purchase_includes_vat,
    NEW.vat_rate,
    NEW.cost_ex_vat_computed,
    NEW.category,
    NEW.margin_override_percent,
    NEW.rounding_override_sek,
    v_pricing.margin_percent,
    v_pricing.rounding,
    NEW.effective_margin_percent,
    NEW.effective_rounding_sek,
    NEW.sell_price_ex_vat,
    NEW.sell_price_inc_vat
  );

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS sku_pricing_after ON public.skus;
CREATE TRIGGER sku_pricing_after
  AFTER INSERT OR UPDATE ON public.skus
  FOR EACH ROW
  EXECUTE FUNCTION public.sku_pricing_after_trigger();

-- 2.4 Margin rules update trigger
CREATE OR REPLACE FUNCTION public.margin_rules_update_trigger()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_sku RECORD;
  v_pricing RECORD;
BEGIN
  -- If margin or rounding changed, recalculate all SKUs in this category
  IF NEW.margin_percent IS DISTINCT FROM OLD.margin_percent OR
     NEW.rounding IS DISTINCT FROM OLD.rounding
  THEN
    FOR v_sku IN SELECT * FROM public.skus WHERE category = NEW.category
    LOOP
      -- Compute new pricing
      SELECT * INTO v_pricing
      FROM public.sku_compute_pricing(
        v_sku.purchase_price,
        v_sku.purchase_includes_vat,
        v_sku.vat_rate,
        v_sku.category,
        v_sku.margin_override_percent,
        v_sku.rounding_override_sek
      );

      -- Update SKU (this will NOT trigger the after trigger because we skip it)
      UPDATE public.skus SET
        cost_ex_vat_computed = v_pricing.cost_ex_vat_computed,
        effective_margin_percent = v_pricing.effective_margin_percent,
        effective_rounding_sek = v_pricing.effective_rounding_sek,
        sell_price_ex_vat = v_pricing.sell_price_ex_vat,
        sell_price_inc_vat = v_pricing.sell_price_inc_vat,
        pricing_updated_at = now()
      WHERE id = v_sku.id;

      -- Insert history directly
      PERFORM public.sku_insert_price_history(
        v_sku.id,
        'category margin change',
        v_sku.purchase_price,
        v_sku.purchase_includes_vat,
        v_sku.vat_rate,
        v_pricing.cost_ex_vat_computed,
        v_sku.category,
        v_sku.margin_override_percent,
        v_sku.rounding_override_sek,
        NEW.margin_percent,
        NEW.rounding,
        v_pricing.effective_margin_percent,
        v_pricing.effective_rounding_sek,
        v_pricing.sell_price_ex_vat,
        v_pricing.sell_price_inc_vat
      );
    END LOOP;
  END IF;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS margin_rules_update ON public.margin_rules;
CREATE TRIGGER margin_rules_update
  AFTER UPDATE ON public.margin_rules
  FOR EACH ROW
  EXECUTE FUNCTION public.margin_rules_update_trigger();

-- =============================================
-- Phase 2.5: Data Migration
-- =============================================

-- Migrate existing cost_ex_vat to purchase_price for all SKUs
UPDATE public.skus
SET purchase_price = COALESCE(cost_ex_vat, 0),
    purchase_includes_vat = false,
    vat_rate = 0.25
WHERE purchase_price = 0 AND cost_ex_vat IS NOT NULL AND cost_ex_vat > 0;

-- Now trigger recalculation by touching all SKUs (this creates history records)
-- We do this by updating a harmless field that won't change anything
-- Actually, we need to force the trigger to run, so we update purchase_price to itself
UPDATE public.skus
SET purchase_price = purchase_price
WHERE purchase_price > 0;