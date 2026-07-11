-- Restore ON DELETE CASCADE from purchase lines to purchases.
--
-- The accounting schema declares acc_purchase_lines.purchase_id with
-- ON DELETE CASCADE, but the deployed database still has a NO ACTION foreign
-- key. Deleting a draft therefore fails with SQLSTATE 23503 while its normal
-- child line remains. Drop any existing FK for this relationship regardless
-- of its name and recreate the canonical cascading constraint.

DO $$
DECLARE
  constraint_name TEXT;
BEGIN
  FOR constraint_name IN
    SELECT constraint_data.conname
    FROM pg_constraint AS constraint_data
    JOIN pg_class AS child_table
      ON child_table.oid = constraint_data.conrelid
    JOIN pg_namespace AS child_schema
      ON child_schema.oid = child_table.relnamespace
    JOIN pg_class AS parent_table
      ON parent_table.oid = constraint_data.confrelid
    JOIN pg_attribute AS child_column
      ON child_column.attrelid = constraint_data.conrelid
     AND child_column.attnum = ANY (constraint_data.conkey)
    WHERE constraint_data.contype = 'f'
      AND child_schema.nspname = 'public'
      AND child_table.relname = 'acc_purchase_lines'
      AND parent_table.relname = 'acc_purchases'
      AND child_column.attname = 'purchase_id'
  LOOP
    EXECUTE format(
      'ALTER TABLE public.acc_purchase_lines DROP CONSTRAINT %I',
      constraint_name
    );
  END LOOP;

  ALTER TABLE public.acc_purchase_lines
    ADD CONSTRAINT acc_purchase_lines_purchase_id_fkey
    FOREIGN KEY (purchase_id)
    REFERENCES public.acc_purchases(id)
    ON DELETE CASCADE;
END $$;
