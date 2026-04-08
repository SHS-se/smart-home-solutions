-- Repair migration for environments where the accounting storage setup
-- was only partially applied or the bucket was created manually.

INSERT INTO storage.buckets (id, name, public)
VALUES ('purchase-documents', 'purchase-documents', false)
ON CONFLICT (id) DO UPDATE
SET
  name = EXCLUDED.name,
  public = EXCLUDED.public;

DROP POLICY IF EXISTS "Staff can upload purchase docs" ON storage.objects;
CREATE POLICY "Staff can upload purchase docs" ON storage.objects
  FOR INSERT TO authenticated
  WITH CHECK (
    bucket_id = 'purchase-documents'
    AND public.is_staff(auth.uid())
  );

DROP POLICY IF EXISTS "Staff can view purchase docs" ON storage.objects;
CREATE POLICY "Staff can view purchase docs" ON storage.objects
  FOR SELECT TO authenticated
  USING (
    bucket_id = 'purchase-documents'
    AND public.is_staff(auth.uid())
  );

DROP POLICY IF EXISTS "Staff can delete purchase docs" ON storage.objects;
CREATE POLICY "Staff can delete purchase docs" ON storage.objects
  FOR DELETE TO authenticated
  USING (
    bucket_id = 'purchase-documents'
    AND public.is_staff(auth.uid())
  );
