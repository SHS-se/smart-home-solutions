import { supabase } from '@/integrations/supabase/client';

export async function getAuthenticatedFunctionHeaders(): Promise<Record<string, string>> {
  const { data: sessionData, error: sessionError } = await supabase.auth.getSession();
  if (sessionError) {
    throw new Error(`Could not read the current session: ${sessionError.message}`);
  }

  let session = sessionData.session;
  if (!session?.access_token) {
    const { data: refreshedData, error: refreshError } = await supabase.auth.refreshSession();
    if (refreshError) {
      throw new Error(`Could not refresh the current session: ${refreshError.message}`);
    }
    session = refreshedData.session;
  }

  if (!session?.access_token) {
    throw new Error('No valid signed-in session was found for this environment. Sign out and sign in again.');
  }

  return {
    Authorization: `Bearer ${session.access_token}`,
  };
}
