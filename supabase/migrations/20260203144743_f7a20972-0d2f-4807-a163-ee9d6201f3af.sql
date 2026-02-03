-- Create storage bucket for invoice PDFs (temporary cache)
INSERT INTO storage.buckets (id, name, public)
VALUES ('invoice-pdfs', 'invoice-pdfs', false)
ON CONFLICT (id) DO NOTHING;

-- Policy: Staff can upload invoice PDFs to their own folder
CREATE POLICY "Staff can upload invoice PDFs to own folder"
ON storage.objects FOR INSERT
WITH CHECK (
  bucket_id = 'invoice-pdfs' 
  AND auth.uid()::text = (storage.foldername(name))[1]
  AND EXISTS (SELECT 1 FROM public.staff_users WHERE user_id = auth.uid())
);

-- Policy: Staff can read their own invoice PDFs
CREATE POLICY "Staff can read own invoice PDFs"
ON storage.objects FOR SELECT
USING (
  bucket_id = 'invoice-pdfs' 
  AND auth.uid()::text = (storage.foldername(name))[1]
  AND EXISTS (SELECT 1 FROM public.staff_users WHERE user_id = auth.uid())
);

-- Policy: Staff can update their own invoice PDFs
CREATE POLICY "Staff can update own invoice PDFs"
ON storage.objects FOR UPDATE
USING (
  bucket_id = 'invoice-pdfs' 
  AND auth.uid()::text = (storage.foldername(name))[1]
  AND EXISTS (SELECT 1 FROM public.staff_users WHERE user_id = auth.uid())
);

-- Policy: Staff can delete their own invoice PDFs
CREATE POLICY "Staff can delete own invoice PDFs"
ON storage.objects FOR DELETE
USING (
  bucket_id = 'invoice-pdfs' 
  AND auth.uid()::text = (storage.foldername(name))[1]
  AND EXISTS (SELECT 1 FROM public.staff_users WHERE user_id = auth.uid())
);