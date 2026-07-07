// Reports which APP_ENV the deployed functions run with (staff diagnostics,
// used by the ERD page). Staff-gated: the value is harmless but there is no
// reason to answer anonymous callers.
import { requireStaff } from '../_shared/staff-auth.ts';

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
};

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') {
    return new Response(null, { headers: corsHeaders });
  }

  const auth = await requireStaff(req, corsHeaders);
  if (auth instanceof Response) return auth;

  const appEnv = Deno.env.get('APP_ENV') || '(not set)';

  return new Response(JSON.stringify({ app_env: appEnv }), {
    headers: { ...corsHeaders, 'Content-Type': 'application/json' },
  });
});
