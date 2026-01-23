-- Add email_token to contacts table for reply matching
ALTER TABLE public.contacts
ADD COLUMN email_token text NOT NULL DEFAULT encode(extensions.gen_random_bytes(16), 'hex');

-- Create unique index on email_token
CREATE UNIQUE INDEX contacts_email_token_idx ON public.contacts(email_token);

-- Create contact_messages table for conversation history
CREATE TABLE public.contact_messages (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  contact_id uuid NOT NULL REFERENCES public.contacts(id) ON DELETE CASCADE,
  body text NOT NULL,
  author_type text NOT NULL CHECK (author_type IN ('lead', 'staff')),
  author_email text NOT NULL,
  source text NOT NULL DEFAULT 'email' CHECK (source IN ('form', 'email', 'portal')),
  created_at timestamp with time zone NOT NULL DEFAULT now()
);

-- Create index for faster lookups by contact_id
CREATE INDEX contact_messages_contact_id_idx ON public.contact_messages(contact_id);

-- Enable Row Level Security
ALTER TABLE public.contact_messages ENABLE ROW LEVEL SECURITY;

-- RLS policies: Staff only access
CREATE POLICY "Staff can view contact messages"
ON public.contact_messages
FOR SELECT
USING (is_staff(auth.uid()));

CREATE POLICY "Staff can insert contact messages"
ON public.contact_messages
FOR INSERT
WITH CHECK (is_staff(auth.uid()));

CREATE POLICY "Staff can update contact messages"
ON public.contact_messages
FOR UPDATE
USING (is_staff(auth.uid()))
WITH CHECK (is_staff(auth.uid()));

CREATE POLICY "Staff can delete contact messages"
ON public.contact_messages
FOR DELETE
USING (is_staff(auth.uid()));