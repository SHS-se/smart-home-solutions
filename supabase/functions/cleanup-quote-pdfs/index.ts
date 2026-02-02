import { serve } from "https://deno.land/std@0.190.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.57.2";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

const logStep = (step: string, details?: Record<string, unknown>) => {
  const detailsStr = details ? ` - ${JSON.stringify(details)}` : '';
  console.log(`[CLEANUP-QUOTE-PDFS] ${step}${detailsStr}`);
};

serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response(null, { headers: corsHeaders });
  }

  try {
    logStep("Function started");

    const supabaseUrl = Deno.env.get("SUPABASE_URL") ?? "";
    const supabaseServiceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "";
    const supabaseAnonKey = Deno.env.get("SUPABASE_ANON_KEY") ?? "";

    // Create client with anon key for auth validation
    const supabaseClient = createClient(supabaseUrl, supabaseAnonKey);
    
    // Create service role client for storage operations
    const supabaseAdmin = createClient(supabaseUrl, supabaseServiceKey);

    // Authenticate user
    const authHeader = req.headers.get("Authorization");
    if (!authHeader) throw new Error("No authorization header provided");

    const token = authHeader.replace("Bearer ", "");
    const { data: userData, error: userError } = await supabaseClient.auth.getUser(token);
    if (userError) throw new Error(`Authentication error: ${userError.message}`);
    if (!userData.user) throw new Error("User not authenticated");

    const userId = userData.user.id;

    logStep("Cleaning up PDFs for user", { userId });

    // List all files in the user's folder
    const { data: files, error: listError } = await supabaseAdmin
      .storage
      .from('quote-pdfs')
      .list(userId);

    if (listError) {
      logStep("Failed to list files", { error: listError.message });
      throw new Error(`Failed to list files: ${listError.message}`);
    }

    if (!files || files.length === 0) {
      logStep("No files to clean up");
      return new Response(
        JSON.stringify({ deleted: 0, message: "No files to clean up" }), 
        {
          headers: { ...corsHeaders, "Content-Type": "application/json" },
          status: 200,
        }
      );
    }

    // Build file paths for deletion
    const filePaths = files.map(f => `${userId}/${f.name}`);

    logStep("Deleting files", { count: filePaths.length });

    // Delete all files in the user's folder
    const { error: deleteError } = await supabaseAdmin
      .storage
      .from('quote-pdfs')
      .remove(filePaths);

    if (deleteError) {
      logStep("Failed to delete files", { error: deleteError.message });
      throw new Error(`Failed to delete files: ${deleteError.message}`);
    }

    logStep("Cleanup complete", { deleted: filePaths.length });

    return new Response(
      JSON.stringify({ 
        deleted: filePaths.length,
        message: `Successfully deleted ${filePaths.length} cached PDF(s)`,
      }), 
      {
        headers: { ...corsHeaders, "Content-Type": "application/json" },
        status: 200,
      }
    );

  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    logStep("ERROR", { message: errorMessage });
    return new Response(JSON.stringify({ error: errorMessage }), {
      headers: { ...corsHeaders, "Content-Type": "application/json" },
      status: 500,
    });
  }
});
