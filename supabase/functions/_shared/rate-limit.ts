import type { SupabaseClient } from "https://esm.sh/@supabase/supabase-js@2.57.2";

/** Consume the allowance atomically; unavailable or invalid storage fails closed. */
export async function consumeRateLimit(
  client: Pick<SupabaseClient, "rpc">,
  identifier: string,
  endpoint: string,
  limit: number,
  windowSeconds: number,
): Promise<{ allowed: boolean; remaining: number }> {
  const { data, error } = await client.rpc("consume_rate_limit", {
    p_identifier: identifier,
    p_endpoint: endpoint,
    p_limit: limit,
    p_window_seconds: windowSeconds,
  });
  const result = Array.isArray(data) && data.length === 1 ? data[0] : null;
  if (error || typeof result?.allowed !== "boolean" || !Number.isInteger(result.remaining)) {
    throw new Error("Rate limit storage unavailable");
  }
  return { allowed: result.allowed, remaining: result.remaining };
}
