import { serve } from "https://deno.land/std@0.190.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.57.2";
import { PDFDocument, StandardFonts, rgb } from "https://esm.sh/pdf-lib@1.17.1";
import { getAppEnvironment } from "../_shared/app-env.ts";
import { loadInvoiceDocumentData } from "../_shared/invoice-document.ts";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type, x-supabase-client-platform, x-supabase-client-platform-version, x-supabase-client-runtime, x-supabase-client-runtime-version",
};

const logStep = (step: string, details?: unknown) => {
  const detailsStr = details ? ` - ${JSON.stringify(details)}` : "";
  console.log(`[GET-INVOICE-PDF] ${step}${detailsStr}`);
};

async function hashToken(tokenHex: string): Promise<string> {
  const encoder = new TextEncoder();
  const hashBuffer = await crypto.subtle.digest("SHA-256", encoder.encode(tokenHex));
  return Array.from(new Uint8Array(hashBuffer)).map(b => b.toString(16).padStart(2, "0")).join("");
}

function formatSEK(amount: number): string {
  return new Intl.NumberFormat("sv-SE", { style: "decimal", minimumFractionDigits: 2, maximumFractionDigits: 2 }).format(amount) + " kr";
}

function formatDate(dateStr: string | null): string {
  if (!dateStr) return "—";
  return new Date(dateStr).toLocaleDateString("sv-SE");
}

function dataUrlToBytes(dataUrl: string): Uint8Array {
  const [, base64] = dataUrl.split(",", 2);
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes;
}

serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response(null, { headers: corsHeaders });
  }

  try {
    const appEnv = getAppEnvironment();
    logStep("Function started", { environment: appEnv });

    const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
    const serviceClient = createClient(supabaseUrl, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);
    const anonClient = createClient(supabaseUrl, Deno.env.get("SUPABASE_ANON_KEY")!);

    // Parse request — supports both authenticated and public token access
    const url = new URL(req.url);
    const invoiceIdParam = url.searchParams.get("invoice_id");
    const tokenParam = url.searchParams.get("token");

    let invoiceId: string;

    if (tokenParam && invoiceIdParam) {
      // Public token access — validate token
      const { data: invoice } = await serviceClient
        .from("invoices")
        .select("id, public_token_hash, public_token_expires_at")
        .eq("id", invoiceIdParam)
        .single();

      if (!invoice) throw new Error("Invoice not found");

      const tokenHash = await hashToken(tokenParam);
      if (invoice.public_token_hash !== tokenHash) throw new Error("Invalid link");
      if (invoice.public_token_expires_at && new Date(invoice.public_token_expires_at) < new Date()) {
        throw new Error("Link expired");
      }
      invoiceId = invoice.id;
    } else {
      // Authenticated access — check staff or customer ownership
      const authHeader = req.headers.get("Authorization");
      if (!authHeader) throw new Error("Missing authorization");
      const token = authHeader.replace("Bearer ", "");
      const { data: userData } = await anonClient.auth.getUser(token);
      if (!userData.user) throw new Error("Unauthorized");

      // Try to get invoice_id from body or query
      let bodyInvoiceId: string | null = null;
      try {
        const body = await req.json();
        bodyInvoiceId = body.invoice_id;
      } catch {
        // No body
      }
      invoiceId = invoiceIdParam || bodyInvoiceId || "";
      if (!invoiceId) throw new Error("invoice_id is required");

      // Verify access: staff can access any, customer can access own
      const { data: staffCheck } = await serviceClient
        .from("staff_users").select("user_id").eq("user_id", userData.user.id).maybeSingle();

      if (!staffCheck) {
        // Customer — verify ownership
        const { data: custCheck } = await serviceClient
          .from("customers").select("id").eq("user_id", userData.user.id).maybeSingle();
        if (!custCheck) throw new Error("Access denied");

        const { data: invoiceCheck } = await serviceClient
          .from("invoices").select("id").eq("id", invoiceId).eq("customer_id", custCheck.id).maybeSingle();
        if (!invoiceCheck) throw new Error("Access denied");
      }
    }

    const invoice = await loadInvoiceDocumentData(serviceClient, invoiceId);
    logStep("Invoice loaded", { invoiceNumber: invoice.invoice_number });

    // ===== Generate PDF =====
    const pdfDoc = await PDFDocument.create();
    const page = pdfDoc.addPage([595.28, 841.89]); // A4
    const font = await pdfDoc.embedFont(StandardFonts.Helvetica);
    const fontBold = await pdfDoc.embedFont(StandardFonts.HelveticaBold);
    const { height } = page.getSize();

    const black = rgb(0, 0, 0);
    const gray = rgb(0.4, 0.4, 0.4);
    const lightGray = rgb(0.85, 0.85, 0.85);

    const leftMargin = 50;
    const rightMargin = 545;
    let y = height - 50;

    // Header: Company name
    page.drawText("Smart Home Solutions AB", { x: leftMargin, y, font: fontBold, size: 16, color: black });

    // Test watermark
    if (appEnv === "test") {
      page.drawText("TEST", { x: rightMargin - 60, y, font: fontBold, size: 14, color: rgb(0.9, 0.2, 0.2) });
    }

    y -= 30;

    // Invoice metadata
    page.drawText("FAKTURA", { x: leftMargin, y, font: fontBold, size: 22, color: black });

    // Right side: invoice details
    const metaX = 350;
    page.drawText("Fakturanummer:", { x: metaX, y, font, size: 9, color: gray });
    page.drawText(invoice.invoice_number || "—", { x: metaX + 100, y, font: fontBold, size: 9, color: black });
    y -= 15;
    page.drawText("Fakturadatum:", { x: metaX, y, font, size: 9, color: gray });
    page.drawText(formatDate(invoice.issued_at || invoice.finalized_at), { x: metaX + 100, y, font, size: 9, color: black });
    y -= 15;
    page.drawText("Förfallodatum:", { x: metaX, y, font, size: 9, color: gray });
    page.drawText(formatDate(invoice.due_date), { x: metaX + 100, y, font, size: 9, color: black });
    y -= 15;
    if (invoice.quote_number) {
      page.drawText("Offertnummer:", { x: metaX, y, font, size: 9, color: gray });
      page.drawText(invoice.quote_number, { x: metaX + 100, y, font, size: 9, color: black });
      y -= 15;
    }

    // Sender block (left)
    let senderY = height - 110;
    page.drawText("Smart Home Solutions AB", { x: leftMargin, y: senderY, font: fontBold, size: 9, color: black });
    senderY -= 13;
    page.drawText("Org.nr: 559XXX-XXXX", { x: leftMargin, y: senderY, font, size: 8, color: gray });
    senderY -= 13;
    page.drawText("support@smarthomesolutions.se", { x: leftMargin, y: senderY, font, size: 8, color: gray });

    // Recipient block (left, below sender)
    let recipY = senderY - 30;
    page.drawText("Mottagare:", { x: leftMargin, y: recipY, font: fontBold, size: 9, color: gray });
    recipY -= 15;
    page.drawText(invoice.customer_name || "—", { x: leftMargin, y: recipY, font: fontBold, size: 10, color: black });
    recipY -= 13;
    if (invoice.customer_address?.street) {
      page.drawText(invoice.customer_address.street, { x: leftMargin, y: recipY, font, size: 9, color: black });
      recipY -= 13;
    }
    if (invoice.customer_address?.postcode || invoice.customer_address?.city) {
      page.drawText(
        `${invoice.customer_address?.postcode || ""} ${invoice.customer_address?.city || ""}`.trim(),
        { x: leftMargin, y: recipY, font, size: 9, color: black },
      );
      recipY -= 13;
    }

    // Line items table
    y = Math.min(y, recipY) - 30;

    // Table header
    page.drawRectangle({ x: leftMargin, y: y - 2, width: rightMargin - leftMargin, height: 18, color: rgb(0.95, 0.95, 0.95) });
    page.drawText("Beskrivning", { x: leftMargin + 5, y: y + 2, font: fontBold, size: 8, color: gray });
    page.drawText("Antal", { x: 340, y: y + 2, font: fontBold, size: 8, color: gray });
    page.drawText("á-pris", { x: 390, y: y + 2, font: fontBold, size: 8, color: gray });
    page.drawText("Moms %", { x: 445, y: y + 2, font: fontBold, size: 8, color: gray });
    page.drawText("Belopp", { x: 500, y: y + 2, font: fontBold, size: 8, color: gray });

    y -= 20;

    // Table rows
    for (const item of invoice.line_items) {
      if (y < 120) break; // Leave room for totals and payment block

      const qty = item.quantity || 1;
      const price = item.unit_price || 0;
      const lineTotal = qty * price;

      // Truncate long descriptions
      let desc = item.description || "";
      if (desc.length > 55) desc = desc.substring(0, 52) + "...";

      page.drawText(desc, { x: leftMargin + 5, y, font, size: 8, color: black });
      page.drawText(String(qty), { x: 340, y, font, size: 8, color: black });
      page.drawText(formatSEK(price), { x: 390, y, font, size: 8, color: black });
      page.drawText(`${item.tax_rate || 25}%`, { x: 445, y, font, size: 8, color: black });
      page.drawText(formatSEK(lineTotal), { x: 500, y, font, size: 8, color: black });

      y -= 14;
    }

    // Divider
    y -= 5;
    page.drawLine({ start: { x: leftMargin, y }, end: { x: rightMargin, y }, thickness: 0.5, color: lightGray });
    y -= 15;

    // Totals block (right-aligned)
    const totalsX = 400;
    const subtotal = invoice.subtotal || 0;
    const tax = invoice.tax || 0;
    const total = invoice.total || 0;

    page.drawText("Summa exkl. moms:", { x: totalsX, y, font, size: 9, color: gray });
    page.drawText(formatSEK(subtotal), { x: 500, y, font, size: 9, color: black });
    y -= 14;
    page.drawText("Moms:", { x: totalsX, y, font, size: 9, color: gray });
    page.drawText(formatSEK(tax), { x: 500, y, font, size: 9, color: black });
    y -= 16;
    page.drawLine({ start: { x: totalsX, y: y + 10 }, end: { x: rightMargin, y: y + 10 }, thickness: 0.5, color: lightGray });
    page.drawText("Att betala:", { x: totalsX, y, font: fontBold, size: 11, color: black });
    page.drawText(formatSEK(total), { x: 500, y, font: fontBold, size: 11, color: black });

    // Payment block at bottom
    y -= 40;
    page.drawLine({ start: { x: leftMargin, y: y + 15 }, end: { x: rightMargin, y: y + 15 }, thickness: 0.5, color: lightGray });

    page.drawText("Betalningsinformation", { x: leftMargin, y, font: fontBold, size: 10, color: black });
    y -= 16;
    page.drawText("Bankgiro:", { x: leftMargin, y, font, size: 9, color: gray });
    page.drawText(invoice.payment_details.bankgiro_number || "Ej konfigurerat", { x: leftMargin + 100, y, font: fontBold, size: 9, color: black });
    y -= 14;
    page.drawText("Betalningsref:", { x: leftMargin, y, font, size: 9, color: gray });
    page.drawText(invoice.payment_details.payment_reference || "—", { x: leftMargin + 100, y, font: fontBold, size: 9, color: black });
    y -= 14;
    page.drawText("Belopp:", { x: leftMargin, y, font, size: 9, color: gray });
    page.drawText(formatSEK(invoice.payment_details.amount), { x: leftMargin + 100, y, font: fontBold, size: 9, color: black });
    y -= 14;
    page.drawText("Förfallodatum:", { x: leftMargin, y, font, size: 9, color: gray });
    page.drawText(formatDate(invoice.payment_details.due_date), { x: leftMargin + 100, y, font: fontBold, size: 9, color: black });
    y -= 14;
    page.drawText("Mottagare:", { x: leftMargin, y, font, size: 9, color: gray });
    page.drawText(invoice.payment_details.payee_name, { x: leftMargin + 100, y, font: fontBold, size: 9, color: black });

    if (invoice.payment_details.qr_data_url) {
      const qrImage = await pdfDoc.embedPng(dataUrlToBytes(invoice.payment_details.qr_data_url));
      page.drawImage(qrImage, {
        x: rightMargin - 95,
        y: y - 55,
        width: 72,
        height: 72,
      });
      page.drawText("QR", {
        x: rightMargin - 60,
        y: y + 18,
        font: fontBold,
        size: 8,
        color: gray,
      });
    }

    y -= 18;
    page.drawText(invoice.payment_details.manual_payment_instruction, {
      x: leftMargin,
      y,
      font,
      size: 8,
      color: gray,
      maxWidth: 330,
      lineHeight: 10,
    });

    // Status watermark for paid/void
    if (invoice.status === "paid") {
      page.drawText("BETALD", { x: 180, y: 400, font: fontBold, size: 60, color: rgb(0.0, 0.6, 0.0), opacity: 0.15, rotate: { type: 'degrees' as any, angle: 45 } });
    } else if (invoice.status === "void") {
      page.drawText("MAKULERAD", { x: 140, y: 400, font: fontBold, size: 50, color: rgb(0.8, 0.0, 0.0), opacity: 0.15, rotate: { type: 'degrees' as any, angle: 45 } });
    }

    const pdfBytes = await pdfDoc.save();
    logStep("PDF generated", { bytes: pdfBytes.length });

    const filename = `Faktura-${invoice.invoice_number || invoice.id}.pdf`;

    return new Response(pdfBytes, {
      headers: {
        ...corsHeaders,
        "Content-Type": "application/pdf",
        "Content-Disposition": `attachment; filename="${filename}"`,
        "Content-Length": String(pdfBytes.length),
      },
      status: 200,
    });

  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    logStep("ERROR", { message: msg });
    return new Response(JSON.stringify({ error: msg }), {
      headers: { ...corsHeaders, "Content-Type": "application/json" },
      status: 500,
    });
  }
});
