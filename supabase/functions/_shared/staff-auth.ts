// Shared caller authentication for edge functions.
//
// Resolves the calling user from the Authorization header and checks
// staff_users membership (optionally admin role). Returns an error Response
// when the caller is not allowed, so handlers can do:
//
//   const auth = await requireStaff(req, corsHeaders);
//   if (auth instanceof Response) return auth;
import { createClient, type SupabaseClient } from "https://esm.sh/@supabase/supabase-js@2.57.2";

export interface StaffAuth {
  userId: string;
  email: string | null;
  role: string;
}

function errorResponse(message: string, status: number, corsHeaders: Record<string, string>): Response {
  return new Response(JSON.stringify({ error: message }), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}

export async function resolveCaller(
  req: Request,
): Promise<{ userId: string; email: string | null } | null> {
  const authHeader = req.headers.get("Authorization");
  if (!authHeader) return null;

  const serviceClient = createClient(
    Deno.env.get("SUPABASE_URL")!,
    Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
  );
  const token = authHeader.replace(/^bearer\s+/i, "").trim();
  const { data, error } = await serviceClient.auth.getUser(token);
  if (error || !data.user) return null;
  return { userId: data.user.id, email: data.user.email ?? null };
}

export async function requireStaff(
  req: Request,
  corsHeaders: Record<string, string>,
  opts: { adminOnly?: boolean } = {},
): Promise<StaffAuth | Response> {
  const caller = await resolveCaller(req);
  if (!caller) return errorResponse("Unauthorized", 401, corsHeaders);

  const serviceClient: SupabaseClient = createClient(
    Deno.env.get("SUPABASE_URL")!,
    Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
  );
  const { data: staffRow } = await serviceClient
    .from("staff_users")
    .select("role")
    .eq("user_id", caller.userId)
    .maybeSingle();

  if (!staffRow) return errorResponse("Forbidden: staff only", 403, corsHeaders);
  if (opts.adminOnly && staffRow.role !== "admin") {
    return errorResponse("Forbidden: admin only", 403, corsHeaders);
  }

  return { userId: caller.userId, email: caller.email, role: staffRow.role };
}
