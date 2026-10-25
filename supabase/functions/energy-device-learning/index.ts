import { createClient } from "https://esm.sh/@supabase/supabase-js@2.57.2";
import { withTrafficMetrics } from "../_shared/edge-traffic.ts";
import { handleDeviceLearning } from "../_shared/device-learning-worker.ts";
Deno.serve(withTrafficMetrics("energy-device-learning", request => handleDeviceLearning(request,
  createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!))));
