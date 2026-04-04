const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
};

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') {
    return new Response(null, { headers: corsHeaders });
  }

  const appEnv = Deno.env.get('APP_ENV') || '(not set)';

  return new Response(JSON.stringify({ app_env: appEnv }), {
    headers: { ...corsHeaders, 'Content-Type': 'application/json' },
  });
});
