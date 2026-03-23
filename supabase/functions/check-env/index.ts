const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
};

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') {
    return new Response(null, { headers: corsHeaders });
  }

  const appEnv = Deno.env.get('APP_ENV') || '(not set)';
  const stripeKey = Deno.env.get('SHS_STRIPE_SECRET_KEY') || '(not set)';
  const oldKey = Deno.env.get('STRIPE_SECRET_KEY') || '(not set)';
  const oldKeyMasked = oldKey.length > 10 ? oldKey.substring(0, 10) + '...' : oldKey;
  const maskedKey = stripeKey.length > 10 ? stripeKey.substring(0, 10) + '...' : stripeKey;

  return new Response(JSON.stringify({ app_env: appEnv, shs_stripe_key_prefix: maskedKey, old_stripe_key_prefix: oldKeyMasked }), {
    headers: { ...corsHeaders, 'Content-Type': 'application/json' },
  });
});
