-- Add profile fields to staff_users so a staff record carries its own contact
-- details (name, email, phone, address) alongside the auth account.
--
-- The auth.users row remains the source of truth for email/password; the
-- manage-staff edge function keeps staff_users.email in sync. email is
-- denormalised here so the staff list can be rendered from a single table read
-- (RLS already lets staff SELECT staff_users).
ALTER TABLE public.staff_users
  ADD COLUMN IF NOT EXISTS full_name text,
  ADD COLUMN IF NOT EXISTS email text,
  ADD COLUMN IF NOT EXISTS phone text,
  ADD COLUMN IF NOT EXISTS address text;

-- Backfill email for existing staff so they show up with their address on the
-- new admin page before they have ever been edited.
UPDATE public.staff_users s
SET email = u.email
FROM auth.users u
WHERE u.id = s.user_id
  AND s.email IS NULL;
