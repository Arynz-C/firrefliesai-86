import { serve } from "https://deno.land/std@0.190.0/http/server.ts";
import Stripe from "https://esm.sh/stripe@14.21.0";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.45.0";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

// Helper logging function for enhanced debugging
const logStep = (step: string, details?: any) => {
  const detailsStr = details ? ` - ${JSON.stringify(details)}` : '';
  console.log(`[CHECK-SUBSCRIPTION] ${step}${detailsStr}`);
};

serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response(null, { headers: corsHeaders });
  }

  // Use the service role key to perform writes (upsert) in Supabase
  const supabaseClient = createClient(
    Deno.env.get("SUPABASE_URL") ?? "",
    Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "",
    { auth: { persistSession: false } }
  );

  try {
    logStep("Function started");

    const stripeKey = Deno.env.get("STRIPE_SECRET_KEY");
    if (!stripeKey) throw new Error("STRIPE_SECRET_KEY is not set");
    logStep("Stripe key verified");

    const authHeader = req.headers.get("Authorization");
    if (!authHeader) throw new Error("No authorization header provided");
    logStep("Authorization header found");

    const token = authHeader.replace("Bearer ", "");
    logStep("Authenticating user with token");
    
    const { data: userData, error: userError } = await supabaseClient.auth.getUser(token);
    if (userError) throw new Error(`Authentication error: ${userError.message}`);
    const user = userData.user;
    if (!user?.email) throw new Error("User not authenticated or email not available");
    logStep("User authenticated", { userId: user.id, email: user.email });

    const stripe = new Stripe(stripeKey, { apiVersion: "2023-10-16" });
    const customers = await stripe.customers.list({ email: user.email, limit: 1 });
    
    // Get current profile status
    const { data: existingProfile } = await supabaseClient
      .from("profiles")
      .select("subscription_plan, stripe_customer_id")
      .eq("user_id", user.id)
      .single();

    logStep("Current profile status", { 
      currentPlan: existingProfile?.subscription_plan,
      stripeCustomerId: existingProfile?.stripe_customer_id,
      stripeCustomersFound: customers.data.length
    });

    // CRITICAL RULE: NEVER override a 'pro' plan that doesn't have a Stripe customer
    // This preserves manual upgrades made directly in the database
    if (existingProfile?.subscription_plan === 'pro' && (!existingProfile?.stripe_customer_id || customers.data.length === 0)) {
      logStep("PRESERVING MANUAL PRO PLAN - Will not override");
      
      // Ensure subscribers table matches the profile
      await supabaseClient.from("subscribers").upsert({
        email: user.email,
        user_id: user.id,
        stripe_customer_id: null,
        subscribed: true,
        subscription_tier: 'pro',
        updated_at: new Date().toISOString(),
      }, { onConflict: 'email' });
      
      return new Response(JSON.stringify({ 
        subscribed: true,
        subscription_tier: 'pro',
        subscription_plan: 'pro'
      }), {
        headers: { ...corsHeaders, "Content-Type": "application/json" },
        status: 200,
      });
    }

    // For users without Stripe customers AND current plan is NOT 'pro', set to free
    if (customers.data.length === 0 && existingProfile?.subscription_plan !== 'pro') {
      logStep("No Stripe customer found, setting to free (current plan is not pro)");
      
      await supabaseClient.from("subscribers").upsert({
        email: user.email,
        user_id: user.id,
        stripe_customer_id: null,
        subscribed: false,
        subscription_tier: 'free',
        subscription_end: null,
        updated_at: new Date().toISOString(),
      }, { onConflict: 'email' });
      
      await supabaseClient.from("profiles").update({
        subscription_plan: 'free',
        subscription_status: 'active'
      }).eq('user_id', user.id);
      
      return new Response(JSON.stringify({ 
        subscribed: false, 
        subscription_tier: 'free',
        subscription_plan: 'free'
      }), {
        headers: { ...corsHeaders, "Content-Type": "application/json" },
        status: 200,
      });
    }

    // If no Stripe customer but plan is 'pro', preserve it
    if (customers.data.length === 0 && existingProfile?.subscription_plan === 'pro') {
      logStep("No Stripe customer but plan is pro - preserving manual upgrade");
      
      await supabaseClient.from("subscribers").upsert({
        email: user.email,
        user_id: user.id,
        stripe_customer_id: null,
        subscribed: true,
        subscription_tier: 'pro',
        subscription_end: null,
        updated_at: new Date().toISOString(),
      }, { onConflict: 'email' });
      
      return new Response(JSON.stringify({ 
        subscribed: true,
        subscription_tier: 'pro',
        subscription_plan: 'pro'
      }), {
        headers: { ...corsHeaders, "Content-Type": "application/json" },
        status: 200,
      });
    }

    const customerId = customers.data[0].id;
    logStep("Found Stripe customer", { customerId });

    const subscriptions = await stripe.subscriptions.list({
      customer: customerId,
      status: "active",
      limit: 1,
    });
    const hasActiveSub = subscriptions.data.length > 0;
    let subscriptionTier = 'free';
    let subscriptionEnd = null;

    if (hasActiveSub) {
      const subscription = subscriptions.data[0];
      subscriptionEnd = new Date(subscription.current_period_end * 1000).toISOString();
      logStep("Active subscription found", { subscriptionId: subscription.id, endDate: subscriptionEnd });
      subscriptionTier = 'pro'; // For now, we only have pro subscription
      logStep("Determined subscription tier", { subscriptionTier });
    } else {
      logStep("No active subscription found");
    }

    await supabaseClient.from("subscribers").upsert({
      email: user.email,
      user_id: user.id,
      stripe_customer_id: customerId,
      subscribed: hasActiveSub,
      subscription_tier: subscriptionTier,
      subscription_end: subscriptionEnd,
      manual_override: false, // Reset manual override for Stripe customers
      updated_at: new Date().toISOString(),
    }, { onConflict: 'email' });

    // Also update profiles table
    await supabaseClient.from("profiles").update({
      subscription_plan: subscriptionTier,
      subscription_status: hasActiveSub ? 'active' : 'cancelled',
      subscription_end_date: subscriptionEnd,
      stripe_customer_id: customerId,
      manual_override: false // Reset manual override for Stripe customers
    }).eq('user_id', user.id);

    logStep("Updated database with subscription info", { subscribed: hasActiveSub, subscriptionTier });
    return new Response(JSON.stringify({
      subscribed: hasActiveSub,
      subscription_tier: subscriptionTier,
      subscription_plan: subscriptionTier,
      subscription_end: subscriptionEnd
    }), {
      headers: { ...corsHeaders, "Content-Type": "application/json" },
      status: 200,
    });
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    logStep("ERROR in check-subscription", { message: errorMessage });
    return new Response(JSON.stringify({ error: errorMessage }), {
      headers: { ...corsHeaders, "Content-Type": "application/json" },
      status: 500,
    });
  }
});