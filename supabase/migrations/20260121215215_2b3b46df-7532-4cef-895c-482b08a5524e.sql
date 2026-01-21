-- Create storage bucket for ticket attachments
INSERT INTO storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
VALUES (
  'ticket-attachments',
  'ticket-attachments',
  false,
  26214400, -- 25MB
  ARRAY[
    'image/jpeg',
    'image/png',
    'image/gif',
    'image/webp',
    'image/svg+xml',
    'text/plain',
    'application/pdf',
    'application/zip',
    'application/gzip',
    'application/json',
    'application/x-gzip'
  ]
);

-- Storage policies for ticket-attachments bucket
-- Check if user can access the ticket (customer user or staff)
CREATE OR REPLACE FUNCTION public.can_access_ticket_storage(storage_path text)
RETURNS boolean
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  path_parts text[];
  customer_uuid uuid;
  ticket_uuid uuid;
BEGIN
  -- Parse path: customer/<customer_id>/ticket/<ticket_id>/<filename>
  path_parts := string_to_array(storage_path, '/');
  
  -- Validate path structure
  IF array_length(path_parts, 1) < 5 THEN
    RETURN false;
  END IF;
  
  IF path_parts[1] != 'customer' OR path_parts[3] != 'ticket' THEN
    RETURN false;
  END IF;
  
  -- Extract UUIDs
  BEGIN
    customer_uuid := path_parts[2]::uuid;
    ticket_uuid := path_parts[4]::uuid;
  EXCEPTION WHEN OTHERS THEN
    RETURN false;
  END;
  
  -- Staff can access all
  IF public.is_staff(auth.uid()) THEN
    RETURN true;
  END IF;
  
  -- Customer can only access their own customer's tickets
  IF public.get_customer_id_for_user(auth.uid()) = customer_uuid THEN
    RETURN EXISTS (
      SELECT 1 FROM public.tickets 
      WHERE id = ticket_uuid AND customer_id = customer_uuid
    );
  END IF;
  
  RETURN false;
END;
$$;

-- Policy: Users can upload to accessible tickets
CREATE POLICY "Users can upload attachments"
ON storage.objects FOR INSERT
TO authenticated
WITH CHECK (
  bucket_id = 'ticket-attachments' 
  AND public.can_access_ticket_storage(name)
);

-- Policy: Users can view attachments from accessible tickets
CREATE POLICY "Users can view attachments"
ON storage.objects FOR SELECT
TO authenticated
USING (
  bucket_id = 'ticket-attachments' 
  AND public.can_access_ticket_storage(name)
);

-- Policy: Users can delete their own attachments (staff can delete any)
CREATE POLICY "Users can delete attachments"
ON storage.objects FOR DELETE
TO authenticated
USING (
  bucket_id = 'ticket-attachments' 
  AND public.can_access_ticket_storage(name)
);