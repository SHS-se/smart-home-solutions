import { createClient } from "https://esm.sh/@supabase/supabase-js@2.57.2";
import { withTrafficMetrics } from "../_shared/edge-traffic.ts";
import { handleLearningDispatch } from "../_shared/learning-dispatch.ts";

Deno.serve(withTrafficMetrics("energy-learning-dispatch", (request, traffic) => handleLearningDispatch(request,
  createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
    { auth: { persistSession: false }, global: { fetch: traffic.fetch } }), traffic.fetch)));
