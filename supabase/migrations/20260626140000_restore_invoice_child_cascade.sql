-- Restore ON DELETE CASCADE on invoice child tables.
--
-- invoice_events and invoice_line_items were declared with
--   invoice_id ... REFERENCES public.invoices(id) ON DELETE CASCADE
-- in 20260201203129, but that migration used CREATE TABLE IF NOT EXISTS.
-- The tables already existed in the (Lovable-managed) database without the
-- cascade, so the CREATE was a no-op and the live foreign keys default to
-- NO ACTION. As a result, deleting an invoice (e.g. a draft) fails with:
--   update or delete on table "invoices" violates foreign key constraint
--   "invoice_events_invoice_id_fkey" on table "invoice_events"
-- because the child rows are never removed. invoice_events has no RLS DELETE
-- policy by design (events are append-only), so the app cannot clear them
-- either -- they are meant to disappear together with their parent invoice.
--
-- This drops whatever invoice_id foreign key currently exists on each child
-- table and re-adds it with ON DELETE CASCADE. It is idempotent.

DO $$
DECLARE
  child TEXT;
  con   TEXT;
BEGIN
  FOREACH child IN ARRAY ARRAY['invoice_events', 'invoice_line_items']
  LOOP
    -- Drop every existing FK from child(invoice_id) -> invoices(id),
    -- regardless of its current name.
    FOR con IN
      SELECT c.conname
      FROM pg_constraint c
      JOIN pg_class     t  ON t.oid  = c.conrelid
      JOIN pg_namespace n  ON n.oid  = t.relnamespace
      JOIN pg_class     rt ON rt.oid = c.confrelid
      JOIN pg_attribute a  ON a.attrelid = c.conrelid AND a.attnum = ANY (c.conkey)
      WHERE c.contype = 'f'
        AND n.nspname  = 'public'
        AND t.relname  = child
        AND rt.relname = 'invoices'
        AND a.attname  = 'invoice_id'
    LOOP
      EXECUTE format('ALTER TABLE public.%I DROP CONSTRAINT %I', child, con);
    END LOOP;

    -- Re-add with the canonical name and ON DELETE CASCADE.
    EXECUTE format(
      'ALTER TABLE public.%I ADD CONSTRAINT %I '
      || 'FOREIGN KEY (invoice_id) REFERENCES public.invoices(id) ON DELETE CASCADE',
      child, child || '_invoice_id_fkey'
    );
  END LOOP;
END $$;
