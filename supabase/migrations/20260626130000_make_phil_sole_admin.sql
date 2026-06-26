-- Make phil@smarthomesolutions.se the only admin for now.
--
-- Staff management (the manage-staff edge function + the staff page) is
-- admin-only. This promotes phil to admin and demotes any other admins to
-- plain staff. Guarded so it is a no-op on any environment where phil's auth
-- account does not exist — that avoids leaving an environment with zero admins.
DO $$
DECLARE
  phil_id uuid;
BEGIN
  SELECT id INTO phil_id
  FROM auth.users
  WHERE email = 'phil@smarthomesolutions.se';

  IF phil_id IS NOT NULL THEN
    -- Ensure phil has a staff record and is admin.
    INSERT INTO public.staff_users (user_id, role, email)
    VALUES (phil_id, 'admin', 'phil@smarthomesolutions.se')
    ON CONFLICT (user_id)
      DO UPDATE SET role = 'admin', email = EXCLUDED.email;

    -- Demote every other admin to staff.
    UPDATE public.staff_users
    SET role = 'staff'
    WHERE user_id <> phil_id
      AND role = 'admin';
  END IF;
END $$;
