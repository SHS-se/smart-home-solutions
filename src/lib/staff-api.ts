import { supabase } from '@/integrations/supabase/client';
import { getResponseErrorMessage } from '@/lib/http-response';

export type ManageStaffAction = 'create' | 'update' | 'set_password' | 'delete';

export interface ManageStaffPayload {
  action: ManageStaffAction;
  user_id?: string;
  email?: string;
  password?: string;
  full_name?: string | null;
  phone?: string | null;
  address?: string | null;
  role?: string;
}

/**
 * Calls the `manage-staff` edge function, returning the parsed JSON body or
 * throwing an Error with a human-readable message on failure.
 */
export async function callManageStaff(
  payload: ManageStaffPayload,
  fallbackMessage: string,
): Promise<{ success: boolean; user_id?: string }> {
  const { data: session } = await supabase.auth.getSession();
  const response = await fetch(
    `${import.meta.env.VITE_SUPABASE_URL}/functions/v1/manage-staff`,
    {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${session.session?.access_token}`,
      },
      body: JSON.stringify(payload),
    },
  );

  if (!response.ok) {
    throw new Error(await getResponseErrorMessage(response, fallbackMessage));
  }

  return response.json();
}
