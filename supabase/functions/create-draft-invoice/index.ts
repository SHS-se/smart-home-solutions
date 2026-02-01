import { serve } from "https://deno.land/std@0.190.0/http/server.ts";
import Stripe from "https://esm.sh/stripe@18.5.0";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.57.2";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

const logStep = (step: string, details?: unknown) => {
  const detailsStr = details ? ` - ${JSON.stringify(details)}` : '';
  console.log(`[CREATE-DRAFT-INVOICE] ${step}${detailsStr}`);
};

serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response(null, { headers: corsHeaders });
  }

  const supabaseClient = createClient(
    Deno.env.get("SUPABASE_URL") ?? "",
    Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "",
    { auth: { persistSession: false } }
  );

  try {
    logStep("Function started");

    const stripeKey = Deno.env.get("STRIPE_SECRET_KEY");
    if (!stripeKey) throw new Error("STRIPE_SECRET_KEY is not set");

    // Authenticate staff user
    const authHeader = req.headers.get("Authorization");
    if (!authHeader) throw new Error("No authorization header provided");
    
    const token = authHeader.replace("Bearer ", "");
    const { data: userData, error: userError } = await supabaseClient.auth.getUser(token);
    if (userError) throw new Error(`Authentication error: ${userError.message}`);
    const user = userData.user;
    if (!user) throw new Error("User not authenticated");

    // Check if user is staff
    const { data: staffData, error: staffError } = await supabaseClient
      .from('staff_users')
      .select('user_id')
      .eq('user_id', user.id)
      .single();

    if (staffError || !staffData) {
      throw new Error("Access denied: Staff only");
    }
    logStep("Staff verified");

    const { 
      customer_id, 
      bom_id, 
      quote_id,
      due_date,
      is_test = false,
      line_items = []
    } = await req.json();

    if (!customer_id) throw new Error("customer_id is required");
    logStep("Creating draft invoice", { customer_id, bom_id, quote_id });

    // Fetch customer
    const { data: customer, error: customerError } = await supabaseClient
      .from('customers')
      .select('*')
      .eq('id', customer_id)
      .single();

    if (customerError || !customer) throw new Error("Customer not found");
    logStep("Customer loaded", { org_name: customer.org_name });

    // Fetch BOM if provided
    let bom = null;
    let bomVersion = null;
    if (bom_id) {
      const { data: bomData, error: bomError } = await supabaseClient
        .from('boms')
        .select('*, bom_items(*, sku:skus(*))')
        .eq('id', bom_id)
        .single();
      
      if (!bomError && bomData) {
        bom = bomData;
        bomVersion = bomData.version;
      }
    }

    // Fetch Quote if provided
    let quote = null;
    let quoteNumber = null;
    if (quote_id) {
      const { data: quoteData, error: quoteError } = await supabaseClient
        .from('quotes')
        .select('*, quote_lines(*)')
        .eq('id', quote_id)
        .single();
      
      if (!quoteError && quoteData) {
        quote = quoteData;
        quoteNumber = quoteData.quote_number;
      }
    }

    const stripe = new Stripe(stripeKey, { apiVersion: "2025-08-27.basil" });

    // Find or create Stripe customer
    const email = customer.billing_email || customer.org_name;
    let stripeCustomerId: string;
    
    const existingCustomers = await stripe.customers.list({
      email: email,
      limit: 1
    });

    if (existingCustomers.data.length > 0) {
      stripeCustomerId = existingCustomers.data[0].id;
      logStep("Found existing Stripe customer", { stripeCustomerId });
    } else {
      const newCustomer = await stripe.customers.create({
        email: email,
        name: customer.org_name || undefined,
        metadata: {
          internal_customer_id: customer_id
        }
      });
      stripeCustomerId = newCustomer.id;
      logStep("Created Stripe customer", { stripeCustomerId });
    }

    // Create draft invoice in Stripe
    const stripeInvoice = await stripe.invoices.create({
      customer: stripeCustomerId,
      collection_method: 'send_invoice',
      days_until_due: due_date ? Math.ceil((new Date(due_date).getTime() - Date.now()) / (1000 * 60 * 60 * 24)) : 30,
      metadata: {
        source: quote_id ? 'quote' : bom_id ? 'bom' : 'manual',
        bom_id: bom_id || '',
        quote_id: quote_id || '',
        is_test: is_test.toString()
      }
    });

    logStep("Created Stripe draft invoice", { 
      stripeInvoiceId: stripeInvoice.id,
      status: stripeInvoice.status 
    });

    // Create the invoice record in our database
    const { data: invoice, error: invoiceError } = await supabaseClient
      .from('invoices')
      .insert({
        stripe_invoice_id: stripeInvoice.id,
        customer_id,
        bom_id: bom_id || null,
        bom_version: bomVersion,
        quote_id: quote_id || null,
        quote_number: quoteNumber,
        status: 'draft',
        is_test,
        due_date: due_date || null,
        currency: 'SEK',
        created_by: user.id
      })
      .select()
      .single();

    if (invoiceError) {
      logStep("Error creating invoice record", { error: invoiceError });
      throw new Error(`Failed to create invoice: ${invoiceError.message}`);
    }

    logStep("Invoice record created", { invoiceId: invoice.id });

    // Insert line items from BOM or Quote
    const lineItemsToInsert: Array<{
      invoice_id: string;
      line_type: string;
      description: string;
      sku?: string;
      sku_id?: string;
      quantity: number;
      unit_price: number;
      unit?: string;
      tax_rate: number;
      category?: string;
      sort_order: number;
    }> = [];

    // If line_items are passed directly, use them
    if (line_items.length > 0) {
      line_items.forEach((item: { line_type: string; description: string; sku?: string; sku_id?: string; quantity: number; unit_price: number; unit?: string; category?: string }, idx: number) => {
        lineItemsToInsert.push({
          invoice_id: invoice.id,
          line_type: item.line_type,
          description: item.description,
          sku: item.sku,
          sku_id: item.sku_id,
          quantity: item.quantity,
          unit_price: item.unit_price,
          unit: item.unit,
          tax_rate: 25,
          category: item.category,
          sort_order: idx
        });
      });
    } 
    // Otherwise, populate from quote lines
    else if (quote && quote.quote_lines) {
      quote.quote_lines.forEach((line: { section: string; description: string; original_sku_code?: string; sku_id?: string; quantity: number; unit_price_ex_vat?: number; unit_price?: number }, idx: number) => {
        const lineType = line.section === 'hardware' ? 'hardware' 
          : line.section === 'labor' ? 'labor' 
          : 'travel_other';
        
        lineItemsToInsert.push({
          invoice_id: invoice.id,
          line_type: lineType,
          description: line.description,
          sku: line.original_sku_code,
          sku_id: line.sku_id,
          quantity: line.quantity,
          unit_price: line.unit_price_ex_vat ?? line.unit_price ?? 0,
          tax_rate: 25,
          sort_order: idx
        });
      });
    }
    // Or from BOM items (hardware only)
    else if (bom && bom.bom_items) {
      bom.bom_items.forEach((item: { sku: { sku: string; name: string; category: string; sell_price_ex_vat: number }; sku_id: string; quantity: number }, idx: number) => {
        lineItemsToInsert.push({
          invoice_id: invoice.id,
          line_type: 'hardware',
          description: item.sku?.name || 'Unknown',
          sku: item.sku?.sku,
          sku_id: item.sku_id,
          quantity: item.quantity,
          unit_price: item.sku?.sell_price_ex_vat || 0,
          tax_rate: 25,
          category: item.sku?.category,
          sort_order: idx
        });
      });
    }

    if (lineItemsToInsert.length > 0) {
      const { error: lineItemsError } = await supabaseClient
        .from('invoice_line_items')
        .insert(lineItemsToInsert);

      if (lineItemsError) {
        logStep("Error inserting line items", { error: lineItemsError });
      } else {
        logStep("Line items inserted", { count: lineItemsToInsert.length });
      }
    }

    // Create invoice event
    await supabaseClient.from('invoice_events').insert({
      invoice_id: invoice.id,
      event_type: 'invoice_created',
      metadata: {
        stripe_invoice_id: stripeInvoice.id,
        source: quote_id ? 'quote' : bom_id ? 'bom' : 'manual'
      },
      created_by: user.id
    });

    logStep("Draft invoice created successfully");

    return new Response(JSON.stringify({
      success: true,
      invoice_id: invoice.id,
      stripe_invoice_id: stripeInvoice.id,
      status: 'draft'
    }), {
      headers: { ...corsHeaders, "Content-Type": "application/json" },
      status: 200,
    });

  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    logStep("ERROR", { message: errorMessage });
    return new Response(JSON.stringify({ error: errorMessage }), {
      headers: { ...corsHeaders, "Content-Type": "application/json" },
      status: 500,
    });
  }
});
