-- Create storage bucket for temporary quote PDFs
INSERT INTO storage.buckets (id, name, public)
VALUES ('quote-pdfs', 'quote-pdfs', false)
ON CONFLICT (id) DO NOTHING;

-- Allow authenticated staff to read from the bucket
CREATE POLICY "Staff can read quote PDFs"
ON storage.objects FOR SELECT
TO authenticated
USING (
  bucket_id = 'quote-pdfs' 
  AND public.is_staff(auth.uid())
);

-- Allow service role to insert (edge function uses service role)
CREATE POLICY "Service role can insert quote PDFs"
ON storage.objects FOR INSERT
TO authenticated
WITH CHECK (
  bucket_id = 'quote-pdfs'
  AND public.is_staff(auth.uid())
);

-- Allow service role to delete old PDFs
CREATE POLICY "Staff can delete quote PDFs"
ON storage.objects FOR DELETE
TO authenticated
USING (
  bucket_id = 'quote-pdfs'
  AND public.is_staff(auth.uid())
);