import type { SupabaseClient } from "https://esm.sh/@supabase/supabase-js@2.57.2";

/** A conditional update with no returned row means another request won. */
export async function claimVerificationToken(client: Pick<SupabaseClient, "from">, id: string): Promise<boolean> {
  const { data, error } = await client.from("verification_tokens")
    .update({ used_at: new Date().toISOString() })
    .eq("id", id)
    .is("used_at", null)
    .select("id")
    .maybeSingle();
  return !error && data?.id === id;
}
