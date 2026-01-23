-- Make ticket_number have a placeholder default so Supabase types show it as optional in Insert
-- The trigger will override this before the row is actually inserted
ALTER TABLE public.tickets 
ALTER COLUMN ticket_number SET DEFAULT '';