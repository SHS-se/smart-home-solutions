
-- Allow customers to view quote_lines for their own non-draft/cancelled quotes
CREATE POLICY "Customers can view own quote_lines"
ON public.quote_lines
FOR SELECT
USING (
  quote_id IN (
    SELECT q.id FROM quotes q
    JOIN customers c ON q.customer_id = c.id
    WHERE c.user_id = auth.uid()
    AND q.status NOT IN ('draft', 'cancelled')
  )
);

-- Allow customers to view BOMs linked to their own quotes (for project name)
CREATE POLICY "Customers can view linked boms"
ON public.boms
FOR SELECT
USING (
  id IN (
    SELECT q.bom_id FROM quotes q
    JOIN customers c ON q.customer_id = c.id
    WHERE c.user_id = auth.uid()
    AND q.bom_id IS NOT NULL
    AND q.status NOT IN ('draft', 'cancelled')
  )
);
