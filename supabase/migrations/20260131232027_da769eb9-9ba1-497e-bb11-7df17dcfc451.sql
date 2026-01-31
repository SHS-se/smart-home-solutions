-- Update existing quote numbers to new format (Q-00000001)
UPDATE quotes
SET quote_number = 'Q-' || LPAD(
  CASE 
    WHEN quote_number ~ '-(\d+)$' THEN (regexp_match(quote_number, '-(\d+)$'))[1]
    ELSE '1'
  END,
  8, '0'
)
WHERE quote_number IS NOT NULL AND quote_number != '';

-- Create or replace the function to generate quote numbers in new format
CREATE OR REPLACE FUNCTION generate_quote_number()
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
  FROM quotes;
  
  -- Set the quote number with 8-digit padding
  NEW.quote_number := 'Q-' || LPAD(next_num::TEXT, 8, '0');
  
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- Drop existing trigger if it exists
DROP TRIGGER IF EXISTS set_quote_number ON quotes;

-- Create trigger to auto-generate quote number on insert
CREATE TRIGGER set_quote_number
  BEFORE INSERT ON quotes
  FOR EACH ROW
  WHEN (NEW.quote_number IS NULL OR NEW.quote_number = '')
  EXECUTE FUNCTION generate_quote_number();