import { supabase } from '@/integrations/supabase/client';

type JwtClaims = Record<string, unknown>;

function decodeJwtClaims(token: string): JwtClaims | null {
  const parts = token.split('.');
  if (parts.length !== 3) {
    return null;
  }

  try {
    const base64 = parts[1].replace(/-/g, '+').replace(/_/g, '/');
    const padding = '='.repeat((4 - (base64.length % 4)) % 4);
    const binary = atob(base64 + padding);
    const bytes = Uint8Array.from(binary, (char) => char.charCodeAt(0));
    const json = new TextDecoder().decode(bytes);
    const parsed = JSON.parse(json);
    return parsed && typeof parsed === 'object' ? parsed as JwtClaims : null;
  } catch {
    return null;
  }
}

function getCurrentProjectRef(): string | null {
  const url = import.meta.env.VITE_SUPABASE_URL;
  if (!url) return null;

  try {
    return new URL(url).hostname.split('.')[0] ?? null;
  } catch {
    return null;
  }
}

function getTokenProjectRef(claims: JwtClaims | null): string | null {
  if (!claims) return null;

  if (typeof claims.ref === 'string' && claims.ref.length > 0) {
    return claims.ref;
  }

  if (typeof claims.iss === 'string') {
    try {
      return new URL(claims.iss).hostname.split('.')[0] ?? null;
    } catch {
      return null;
    }
  }

  return null;
}

function buildInvalidSessionMessage(accessToken: string, authErrorMessage: string): string {
  const claims = decodeJwtClaims(accessToken);
  const currentProjectRef = getCurrentProjectRef();
  const tokenProjectRef = getTokenProjectRef(claims);

  if (claims && claims.role === 'anon' && typeof claims.sub !== 'string') {
    return 'The app is sending the Supabase publishable key instead of a signed-in user session. The browser session is missing or not being read for this environment.';
  }

  if (currentProjectRef && tokenProjectRef && currentProjectRef !== tokenProjectRef) {
    return `Your browser session belongs to Supabase project ${tokenProjectRef}, but this app is using ${currentProjectRef}. Open the correct environment, sign in there, and try again.`;
  }

  if (/jwt expired/i.test(authErrorMessage)) {
    return 'Your session has expired for this environment. Refresh the page, sign in again, and retry.';
  }

  if (/invalid jwt/i.test(authErrorMessage)) {
    return 'The browser has a session token for this environment, but Supabase rejected it as invalid. This usually means stale or mismatched auth state in the browser.';
  }

  return `The current browser session could not be validated: ${authErrorMessage}`;
}

async function validateAccessToken(accessToken: string): Promise<string | null> {
  const { error } = await supabase.auth.getUser(accessToken);
  return error?.message ?? null;
}

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

  let accessToken = session.access_token;
  let validationError = await validateAccessToken(accessToken);

  if (validationError) {
    const { data: refreshedData, error: refreshError } = await supabase.auth.refreshSession();
    if (!refreshError && refreshedData.session?.access_token) {
      accessToken = refreshedData.session.access_token;
      validationError = await validateAccessToken(accessToken);
    }
  }

  if (validationError) {
    throw new Error(buildInvalidSessionMessage(accessToken, validationError));
  }

  return {
    Authorization: `Bearer ${accessToken}`,
  };
}
