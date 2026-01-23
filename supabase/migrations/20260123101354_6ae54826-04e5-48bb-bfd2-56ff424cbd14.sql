-- Add ticket_number column with auto-incrementing sequence
CREATE SEQUENCE IF NOT EXISTS ticket_number_seq START WITH 1 INCREMENT BY 1;

-- Add the ticket_number column
ALTER TABLE public.tickets 
ADD COLUMN ticket_number TEXT UNIQUE;

-- Create function to generate ticket number
CREATE OR REPLACE FUNCTION public.generate_ticket_number()
RETURNS TRIGGER AS $$
BEGIN
  NEW.ticket_number := 'TKT-' || LPAD(nextval('ticket_number_seq')::TEXT, 5, '0');
  RETURN NEW;
END;
$$ LANGUAGE plpgsql SET search_path = public;

-- Create trigger to auto-generate ticket number on insert
CREATE TRIGGER set_ticket_number
  BEFORE INSERT ON public.tickets
  FOR EACH ROW
  EXECUTE FUNCTION public.generate_ticket_number();

-- Backfill existing tickets with sequential numbers based on created_at order
WITH numbered_tickets AS (
  SELECT id, ROW_NUMBER() OVER (ORDER BY created_at ASC) as seq_num
  FROM public.tickets
  WHERE ticket_number IS NULL
)
UPDATE public.tickets t
SET ticket_number = 'TKT-' || LPAD(nt.seq_num::TEXT, 5, '0')
FROM numbered_tickets nt
WHERE t.id = nt.id;

-- Update sequence to continue from the max used number
SELECT setval('ticket_number_seq', COALESCE(
  (SELECT MAX(SUBSTRING(ticket_number FROM 5)::INT) FROM public.tickets WHERE ticket_number IS NOT NULL),
  0
));

-- Make ticket_number NOT NULL after backfill
ALTER TABLE public.tickets 
ALTER COLUMN ticket_number SET NOT NULL;