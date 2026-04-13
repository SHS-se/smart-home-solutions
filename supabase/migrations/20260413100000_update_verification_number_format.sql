-- Update verification number format from V-YYYY-NNN to VYYMM-N
-- The new format groups by year+month with an unpadded sequence index.
-- Examples: V2601-1, V2602-5, V2603-123

-- Drop the old global sequence — no longer needed since numbering is per-month
DROP SEQUENCE IF EXISTS acc_verification_number_seq;

-- Replace the SQL function (kept as a fallback; the app uses the TS allocator)
CREATE OR REPLACE FUNCTION public.allocate_acc_verification_number(p_date date DEFAULT CURRENT_DATE)
RETURNS text
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $$
DECLARE
  v_yy text;
  v_mm text;
  v_prefix text;
  v_max int;
BEGIN
  v_yy := to_char(p_date, 'YY');
  v_mm := to_char(p_date, 'MM');
  v_prefix := 'V' || v_yy || v_mm || '-';

  SELECT COALESCE(MAX(
    CAST(substring(verification_number FROM length(v_prefix) + 1) AS int)
  ), 0)
  INTO v_max
  FROM acc_verifications
  WHERE verification_number LIKE v_prefix || '%';

  RETURN v_prefix || (v_max + 1)::text;
END;
$$;
