-- Allow customers to view their own quotes (non-draft, non-cancelled)
CREATE POLICY "Customers can view own quotes"
ON public.quotes
FOR SELECT
USING (
  customer_id = (
    SELECT id FROM public.customers 
    WHERE user_id = auth.uid()
    LIMIT 1
  )
  AND status NOT IN ('draft', 'cancelled')
);