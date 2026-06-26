import { serve } from "https://deno.land/std@0.190.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type",
};

type Action = "create" | "update" | "set_password" | "delete";

interface ManageStaffRequest {
  action: Action;
  user_id?: string;
  email?: string;
  password?: string;
  full_name?: string | null;
  phone?: string | null;
  address?: string | null;
  role?: string;
}

const json = (body: unknown, status = 200): Response =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json", ...corsHeaders },
  });

const isValidRole = (role: unknown): role is "staff" | "admin" =>
  role === "staff" || role === "admin";

serve(async (req: Request): Promise<Response> => {
  if (req.method === "OPTIONS") {
    return new Response(null, { headers: corsHeaders });
  }

  const supabaseUrl = Deno.env.get("SUPABASE_URL");
  const supabaseServiceRoleKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");

  if (!supabaseUrl || !supabaseServiceRoleKey) {
    return json({ error: "Server configuration error" }, 500);
  }

  const supabaseAdmin = createClient(supabaseUrl, supabaseServiceRoleKey);

  // Verify the caller is staff.
  const authHeader = req.headers.get("Authorization") ??
    req.headers.get("authorization");
  if (!authHeader) {
    return json({ error: "Unauthorized" }, 401);
  }

  const token = authHeader.replace(/^bearer\s+/i, "").trim();
  const { data: { user }, error: authError } = await supabaseAdmin.auth.getUser(
    token,
  );
  if (authError || !user) {
    return json({ error: "Unauthorized" }, 401);
  }

  const { data: callerStaff, error: callerError } = await supabaseAdmin
    .from("staff_users")
    .select("role")
    .eq("user_id", user.id)
    .maybeSingle();

  if (callerError) {
    return json({ error: "Failed to verify staff access" }, 500);
  }
  if (!callerStaff || callerStaff.role !== "admin") {
    return json({ error: "Only admins can manage staff users" }, 403);
  }

  try {
    const body: ManageStaffRequest = await req.json();
    const action = body.action;

    if (action === "create") {
      const email = body.email?.trim().toLowerCase();
      const password = body.password ?? "";
      const role = body.role ?? "staff";

      if (!email || !password) {
        return json({ error: "Email and password are required" }, 400);
      }
      if (password.length < 8) {
        return json({ error: "Password must be at least 8 characters" }, 400);
      }
      if (!isValidRole(role)) {
        return json({ error: "Invalid role" }, 400);
      }

      // Reject if an auth user already exists with this email to avoid
      // accidentally hijacking a customer or existing account.
      const { data: existing } = await supabaseAdmin.auth.admin.listUsers();
      const existingUsers = (existing?.users ?? []) as Array<
        { email?: string | null }
      >;
      const clash = existingUsers.find(
        (u) => u.email?.toLowerCase() === email,
      );
      if (clash) {
        return json(
          { error: "A user with this email already exists" },
          400,
        );
      }

      const { data: created, error: createError } = await supabaseAdmin.auth
        .admin.createUser({
          email,
          password,
          email_confirm: true,
        });

      if (createError || !created?.user) {
        return json(
          { error: createError?.message || "Failed to create user" },
          500,
        );
      }

      const newUserId = created.user.id;

      const { error: insertError } = await supabaseAdmin
        .from("staff_users")
        .insert({
          user_id: newUserId,
          role,
          full_name: body.full_name ?? null,
          email,
          phone: body.phone ?? null,
          address: body.address ?? null,
        });

      if (insertError) {
        // Roll back the auth user so we don't leave an orphan account.
        await supabaseAdmin.auth.admin.deleteUser(newUserId);
        return json(
          { error: insertError.message || "Failed to create staff record" },
          500,
        );
      }

      return json({ success: true, user_id: newUserId });
    }

    if (action === "update") {
      const targetId = body.user_id;
      if (!targetId) {
        return json({ error: "Missing user_id" }, 400);
      }

      const { data: targetStaff } = await supabaseAdmin
        .from("staff_users")
        .select("user_id, email")
        .eq("user_id", targetId)
        .maybeSingle();

      if (!targetStaff) {
        return json({ error: "Staff user not found" }, 404);
      }

      const role = body.role ?? "staff";
      if (!isValidRole(role)) {
        return json({ error: "Invalid role" }, 400);
      }

      const email = body.email?.trim().toLowerCase();
      if (!email) {
        return json({ error: "Email is required" }, 400);
      }

      // Sync the auth account email if it changed.
      if (email !== targetStaff.email?.toLowerCase()) {
        const { error: emailError } = await supabaseAdmin.auth.admin
          .updateUserById(targetId, { email, email_confirm: true });
        if (emailError) {
          return json(
            { error: emailError.message || "Failed to update email" },
            500,
          );
        }
      }

      const { error: updateError } = await supabaseAdmin
        .from("staff_users")
        .update({
          role,
          full_name: body.full_name ?? null,
          email,
          phone: body.phone ?? null,
          address: body.address ?? null,
        })
        .eq("user_id", targetId);

      if (updateError) {
        return json(
          { error: updateError.message || "Failed to update staff user" },
          500,
        );
      }

      return json({ success: true, user_id: targetId });
    }

    if (action === "set_password") {
      const targetId = body.user_id;
      const password = body.password ?? "";

      if (!targetId) {
        return json({ error: "Missing user_id" }, 400);
      }
      if (password.length < 8) {
        return json({ error: "Password must be at least 8 characters" }, 400);
      }

      const { data: targetStaff } = await supabaseAdmin
        .from("staff_users")
        .select("user_id")
        .eq("user_id", targetId)
        .maybeSingle();

      if (!targetStaff) {
        return json({ error: "Staff user not found" }, 404);
      }

      const { error: pwError } = await supabaseAdmin.auth.admin.updateUserById(
        targetId,
        { password },
      );
      if (pwError) {
        return json(
          { error: pwError.message || "Failed to update password" },
          500,
        );
      }

      return json({ success: true, user_id: targetId });
    }

    if (action === "delete") {
      const targetId = body.user_id;
      if (!targetId) {
        return json({ error: "Missing user_id" }, 400);
      }
      if (targetId === user.id) {
        return json({ error: "You cannot delete your own account" }, 400);
      }

      const { data: targetStaff } = await supabaseAdmin
        .from("staff_users")
        .select("user_id")
        .eq("user_id", targetId)
        .maybeSingle();

      if (!targetStaff) {
        return json({ error: "Staff user not found" }, 404);
      }

      // Removing the auth user cascades the staff_users row (FK ON DELETE
      // CASCADE), but delete the staff row first so the record is gone even if
      // auth deletion is delayed.
      await supabaseAdmin.from("staff_users").delete().eq("user_id", targetId);
      const { error: deleteError } = await supabaseAdmin.auth.admin.deleteUser(
        targetId,
      );
      if (deleteError) {
        return json(
          { error: deleteError.message || "Failed to delete staff user" },
          500,
        );
      }

      return json({ success: true });
    }

    return json({ error: "Unknown action" }, 400);
  } catch (error) {
    console.error("Error in manage-staff:", error);
    const message = error instanceof Error ? error.message : "Unexpected error";
    return json({ error: message }, 500);
  }
});
