import { createClient } from "https://esm.sh/@supabase/supabase-js@2.57.2";
import { withTrafficMetrics } from "./edge-traffic.ts";
import { handleDeviceLearning } from "./device-learning-worker.ts";

/** Each physical slot has its own function isolate; the learner is shared. */
export function learningExecutorHandler(endpoint: "energy-device-learning" | "energy-device-learning-peer") {
  return withTrafficMetrics(endpoint, (request, traffic) => handleDeviceLearning(request,
    createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
      { auth: { persistSession: false }, global: { fetch: traffic.fetch } }), Date.now, endpoint));
}
