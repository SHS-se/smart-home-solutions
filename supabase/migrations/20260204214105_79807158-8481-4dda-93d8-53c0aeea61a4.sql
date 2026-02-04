-- Add is_test column to customers table
ALTER TABLE public.customers 
ADD COLUMN is_test boolean NOT NULL DEFAULT false;