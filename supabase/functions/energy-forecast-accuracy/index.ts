import { createClient } from 'https://esm.sh/@supabase/supabase-js@2.57.2';
import { handleForecastAccuracy } from '../_shared/forecast-accuracy-store.ts';
import { withTrafficMetrics } from '../_shared/edge-traffic.ts';

Deno.serve(withTrafficMetrics('energy-forecast-accuracy', (request, traffic) => handleForecastAccuracy(request,
  createClient(Deno.env.get('SUPABASE_URL') ?? '', Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? '',
    {auth: {persistSession: false}, global: {fetch: traffic.fetch}}))));
