-- Drop existing foreign key constraint
ALTER TABLE public.contacts
DROP CONSTRAINT IF EXISTS contacts_converted_to_customer_id_fkey;

-- Re-add with ON DELETE SET NULL
ALTER TABLE public.contacts
ADD CONSTRAINT contacts_converted_to_customer_id_fkey
FOREIGN KEY (converted_to_customer_id)
REFERENCES public.customers(id)
ON DELETE SET NULL;