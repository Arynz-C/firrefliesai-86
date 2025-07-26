import { serve } from "https://deno.land/std@0.190.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.45.0";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response(null, { headers: corsHeaders });
  }

  // Use the service role key for admin operations
  const supabaseClient = createClient(
    Deno.env.get("SUPABASE_URL") ?? "",
    Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "",
    { auth: { persistSession: false } }
  );

  try {
    const { userId, subscriptionPlan, enable } = await req.json();
    
    if (!userId) {
      throw new Error("User ID is required");
    }

    const planToSet = subscriptionPlan || 'pro';
    const isUpgrade = planToSet === 'pro';

    // Update both tables with manual override
    const [profileUpdate, subscriberUpdate] = await Promise.all([
      supabaseClient.from("profiles").update({
        subscription_plan: planToSet,
        subscription_status: 'active',
        manual_override: enable !== false, // Default to true unless explicitly set to false
        updated_at: new Date().toISOString(),
      }).eq('user_id', userId),

      supabaseClient.from("subscribers").upsert({
        user_id: userId,
        subscribed: isUpgrade,
        subscription_tier: planToSet,
        manual_override: enable !== false, // Default to true unless explicitly set to false
        updated_at: new Date().toISOString(),
      }, { onConflict: 'user_id' })
    ]);

    if (profileUpdate.error) throw profileUpdate.error;
    if (subscriberUpdate.error) throw subscriberUpdate.error;

    return new Response(JSON.stringify({
      success: true,
      message: `User ${userId} ${enable !== false ? 'upgraded' : 'downgraded'} to ${planToSet} with manual override`,
      subscription_plan: planToSet,
      manual_override: enable !== false
    }), {
      headers: { ...corsHeaders, "Content-Type": "application/json" },
      status: 200,
    });

  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    return new Response(JSON.stringify({ error: errorMessage }), {
      headers: { ...corsHeaders, "Content-Type": "application/json" },
      status: 500,
    });
  }
});