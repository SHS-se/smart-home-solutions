-- Step 1: Update sku_compute_pricing to use category_id
CREATE OR REPLACE FUNCTION public.sku_compute_pricing(
  p_purchase_price numeric,
  p_purchase_includes_vat boolean,
  p_vat_rate numeric,
  p_category_id uuid,
  p_margin_override_percent numeric,
  p_rounding_override_sek integer
)
RETURNS TABLE(
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
SET search_path TO 'public'
AS $function$
DECLARE
  v_cost_ex_vat numeric;
  v_rule_margin numeric;
  v_rule_rounding integer;
  v_effective_margin numeric;
  v_effective_rounding integer;
  v_raw_price numeric;
  v_sell_ex_vat numeric;
  v_sell_inc_vat numeric;
  v_category_name text;
BEGIN
  -- Compute cost ex VAT
  IF p_purchase_includes_vat THEN
    v_cost_ex_vat := p_purchase_price / (1 + p_vat_rate);
  ELSE
    v_cost_ex_vat := p_purchase_price;
  END IF;

  -- Look up category margin rules by category_id
  SELECT mr.margin_percent, mr.rounding, sc.name
  INTO v_rule_margin, v_rule_rounding, v_category_name
  FROM public.margin_rules mr
  JOIN public.sku_categories sc ON mr.category_id = sc.id
  WHERE mr.category_id = p_category_id;

  IF NOT FOUND THEN
    -- Get category name for error message
    SELECT name INTO v_category_name FROM public.sku_categories WHERE id = p_category_id;
    RAISE EXCEPTION 'No margin rule found for category_id "%" (name: %)', p_category_id, COALESCE(v_category_name, 'unknown');
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
$function$;

-- Step 2: Update sku_pricing_before_trigger to use category_id
CREATE OR REPLACE FUNCTION public.sku_pricing_before_trigger()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  v_pricing RECORD;
BEGIN
  -- Only recalculate if pricing-affecting fields changed
  IF TG_OP = 'INSERT' OR
     NEW.purchase_price IS DISTINCT FROM OLD.purchase_price OR
     NEW.purchase_includes_vat IS DISTINCT FROM OLD.purchase_includes_vat OR
     NEW.vat_rate IS DISTINCT FROM OLD.vat_rate OR
     NEW.category_id IS DISTINCT FROM OLD.category_id OR
     NEW.margin_override_percent IS DISTINCT FROM OLD.margin_override_percent OR
     NEW.rounding_override_sek IS DISTINCT FROM OLD.rounding_override_sek
  THEN
    -- Validate category_id is set
    IF NEW.category_id IS NULL THEN
      RAISE EXCEPTION 'category_id is required for SKU pricing calculation';
    END IF;

    -- Compute pricing using category_id
    SELECT * INTO v_pricing
    FROM public.sku_compute_pricing(
      NEW.purchase_price,
      NEW.purchase_includes_vat,
      NEW.vat_rate,
      NEW.category_id,
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
$function$;

-- Step 3: Update sku_insert_price_history to use category_id
CREATE OR REPLACE FUNCTION public.sku_insert_price_history(
  p_sku_id uuid,
  p_change_reason text,
  p_purchase_price numeric,
  p_purchase_includes_vat boolean,
  p_vat_rate numeric,
  p_cost_ex_vat numeric,
  p_category_id uuid,
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
SET search_path TO 'public'
AS $function$
DECLARE
  v_category_name text;
BEGIN
  -- Look up category name for the history record
  SELECT name INTO v_category_name FROM public.sku_categories WHERE id = p_category_id;
  
  INSERT INTO public.sku_price_history (
    sku_id, changed_at, changed_by, change_reason,
    purchase_price, purchase_includes_vat, vat_rate, cost_ex_vat, category,
    margin_override_percent, rounding_override_sek,
    rule_margin_percent, rule_rounding_sek,
    effective_margin_percent, effective_rounding_sek,
    sell_price_ex_vat, sell_price_inc_vat
  ) VALUES (
    p_sku_id, now(), auth.uid(), p_change_reason,
    p_purchase_price, p_purchase_includes_vat, p_vat_rate, p_cost_ex_vat, v_category_name,
    p_margin_override_percent, p_rounding_override_sek,
    p_rule_margin_percent, p_rule_rounding_sek,
    p_effective_margin_percent, p_effective_rounding_sek,
    p_sell_price_ex_vat, p_sell_price_inc_vat
  );
END;
$function$;

-- Step 4: Update sku_pricing_after_trigger to use category_id
CREATE OR REPLACE FUNCTION public.sku_pricing_after_trigger()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
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
        NEW.category_id IS DISTINCT FROM OLD.category_id OR
        NEW.margin_override_percent IS DISTINCT FROM OLD.margin_override_percent OR
        NEW.rounding_override_sek IS DISTINCT FROM OLD.rounding_override_sek
  THEN
    v_reason := 'pricing fields updated';
  ELSE
    RETURN NEW;
  END IF;

  -- Get rule values for history using category_id
  SELECT mr.margin_percent, mr.rounding
  INTO v_pricing
  FROM public.margin_rules mr
  WHERE mr.category_id = NEW.category_id;

  -- Insert history using SECURITY DEFINER function with category_id
  PERFORM public.sku_insert_price_history(
    NEW.id,
    v_reason,
    NEW.purchase_price,
    NEW.purchase_includes_vat,
    NEW.vat_rate,
    NEW.cost_ex_vat_computed,
    NEW.category_id,
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
$function$;

-- Step 5: Update margin_rules_update_trigger to use category_id
CREATE OR REPLACE FUNCTION public.margin_rules_update_trigger()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  v_sku RECORD;
  v_pricing RECORD;
BEGIN
  -- If margin or rounding changed, recalculate all SKUs in this category
  IF NEW.margin_percent IS DISTINCT FROM OLD.margin_percent OR
     NEW.rounding IS DISTINCT FROM OLD.rounding
  THEN
    FOR v_sku IN SELECT * FROM public.skus WHERE category_id = NEW.category_id
    LOOP
      -- Compute new pricing using category_id
      SELECT * INTO v_pricing
      FROM public.sku_compute_pricing(
        v_sku.purchase_price,
        v_sku.purchase_includes_vat,
        v_sku.vat_rate,
        v_sku.category_id,
        v_sku.margin_override_percent,
        v_sku.rounding_override_sek
      );

      -- Update SKU
      UPDATE public.skus SET
        cost_ex_vat_computed = v_pricing.cost_ex_vat_computed,
        effective_margin_percent = v_pricing.effective_margin_percent,
        effective_rounding_sek = v_pricing.effective_rounding_sek,
        sell_price_ex_vat = v_pricing.sell_price_ex_vat,
        sell_price_inc_vat = v_pricing.sell_price_inc_vat,
        pricing_updated_at = now()
      WHERE id = v_sku.id;

      -- Insert history directly using category_id
      PERFORM public.sku_insert_price_history(
        v_sku.id,
        'category margin change',
        v_sku.purchase_price,
        v_sku.purchase_includes_vat,
        v_sku.vat_rate,
        v_pricing.cost_ex_vat_computed,
        v_sku.category_id,
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
$function$;