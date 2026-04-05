import { serve } from "https://deno.land/std@0.190.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.57.2";
import { PDFDocument, StandardFonts, degrees, rgb, type PDFPage, type PDFFont } from "https://esm.sh/pdf-lib@1.17.1";
import { getAppEnvironment } from "../_shared/app-env.ts";
import { INVOICE_COMPANY } from "../_shared/invoice-company.ts";
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
  return Array.from(new Uint8Array(hashBuffer)).map((b) => b.toString(16).padStart(2, "0")).join("");
}

function formatSEK(amount: number): string {
  return new Intl.NumberFormat("sv-SE", {
    style: "decimal",
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  }).format(amount) + " kr";
}

function formatQuantity(quantity: number): string {
  if (Number.isInteger(quantity)) {
    return String(quantity);
  }

  return new Intl.NumberFormat("sv-SE", {
    minimumFractionDigits: 0,
    maximumFractionDigits: 2,
  }).format(quantity);
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

function drawRightAlignedText(
  page: PDFPage,
  text: string,
  rightX: number,
  y: number,
  font: PDFFont,
  size: number,
  color: ReturnType<typeof rgb>,
) {
  page.drawText(text, {
    x: rightX - font.widthOfTextAtSize(text, size),
    y,
    font,
    size,
    color,
  });
}

function drawMetadataRow(
  page: PDFPage,
  label: string,
  value: string,
  y: number,
  font: PDFFont,
  fontBold: PDFFont,
  labelX: number,
  valueRightX: number,
  gray: ReturnType<typeof rgb>,
  black: ReturnType<typeof rgb>,
) {
  page.drawText(label, { x: labelX, y, font, size: 8.5, color: gray });
  drawRightAlignedText(page, value, valueRightX, y, fontBold, 8.5, black);
}

function drawShsLogo(
  page: PDFPage,
  x: number,
  y: number,
  width: number,
  height: number,
  fontBold: PDFFont,
  brandBlue: ReturnType<typeof rgb>,
  white: ReturnType<typeof rgb>,
) {
  page.drawRectangle({
    x,
    y,
    width,
    height,
    color: brandBlue,
  });

  page.drawSvgPath("M20 10 L45 2 L45 12 L70 20 L70 54 L44 62 L44 72 L20 64 L20 54 L4 50 L4 26 L20 22 Z", {
    x: x + 5,
    y: y + 4,
    scale: Math.min(width / 78, height / 76),
    borderColor: white,
    borderWidth: 2.8,
  });

  page.drawText("SHS", {
    x: x + 13,
    y: y + height / 2 - 11,
    font: fontBold,
    size: 28,
    color: white,
  });
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

    const url = new URL(req.url);
    const invoiceIdParam = url.searchParams.get("invoice_id");
    const tokenParam = url.searchParams.get("token");

    let invoiceId: string;

    if (tokenParam && invoiceIdParam) {
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
      const authHeader = req.headers.get("Authorization");
      if (!authHeader) throw new Error("Missing authorization");

      const token = authHeader.replace("Bearer ", "");
      const { data: userData } = await anonClient.auth.getUser(token);
      if (!userData.user) throw new Error("Unauthorized");

      let bodyInvoiceId: string | null = null;

      try {
        const body = await req.json();
        bodyInvoiceId = body.invoice_id;
      } catch {
        // No body
      }

      invoiceId = invoiceIdParam || bodyInvoiceId || "";
      if (!invoiceId) throw new Error("invoice_id is required");

      const { data: staffCheck } = await serviceClient
        .from("staff_users")
        .select("user_id")
        .eq("user_id", userData.user.id)
        .maybeSingle();

      if (!staffCheck) {
        const { data: custCheck } = await serviceClient
          .from("customers")
          .select("id")
          .eq("user_id", userData.user.id)
          .maybeSingle();

        if (!custCheck) throw new Error("Access denied");

        const { data: invoiceCheck } = await serviceClient
          .from("invoices")
          .select("id")
          .eq("id", invoiceId)
          .eq("customer_id", custCheck.id)
          .maybeSingle();

        if (!invoiceCheck) throw new Error("Access denied");
      }
    }

    const invoice = await loadInvoiceDocumentData(serviceClient, invoiceId);
    logStep("Invoice loaded", { invoiceNumber: invoice.invoice_number });

    const pdfDoc = await PDFDocument.create();
    const page = pdfDoc.addPage([595.28, 841.89]);
    const font = await pdfDoc.embedFont(StandardFonts.Helvetica);
    const fontBold = await pdfDoc.embedFont(StandardFonts.HelveticaBold);
    const { height } = page.getSize();

    const black = rgb(0, 0, 0);
    const gray = rgb(0.38, 0.38, 0.38);
    const lightGray = rgb(0.84, 0.86, 0.89);
    const softGray = rgb(0.97, 0.98, 0.99);
    const brandBlue = rgb(0.2, 0.41, 0.64);
    const white = rgb(1, 1, 1);

    const leftMargin = 50;
    const rightMargin = 545;
    const contentWidth = rightMargin - leftMargin;
    const metaLabelX = 372;
    const metaValueRightX = rightMargin;

    const customerPostcodeCity = [
      invoice.customer_address?.postcode,
      invoice.customer_address?.city,
    ].filter(Boolean).join(" ") || "—";

    const logoWidth = 78;
    const logoHeight = 68;
    const headerTopY = height - 48;
    const companyNameSize = 18;
    const companyNameTopY = headerTopY + 6;
    const companyNameBaselineY = companyNameTopY - companyNameSize;

    drawShsLogo(page, leftMargin, companyNameTopY - logoHeight, logoWidth, logoHeight, fontBold, brandBlue, white);

    const companyX = leftMargin + logoWidth + 16;
    page.drawText(INVOICE_COMPANY.name, {
      x: companyX,
      y: companyNameBaselineY,
      font: fontBold,
      size: companyNameSize,
      color: black,
    });
    page.drawText(INVOICE_COMPANY.street, {
      x: companyX,
      y: companyNameBaselineY - 16,
      font,
      size: 9,
      color: gray,
    });
    page.drawText(`${INVOICE_COMPANY.postcode} ${INVOICE_COMPANY.city}`, {
      x: companyX,
      y: companyNameBaselineY - 29,
      font,
      size: 9,
      color: gray,
    });
    page.drawText(`Org.nr ${INVOICE_COMPANY.orgNumber} · VAT ${INVOICE_COMPANY.vatNumber}`, {
      x: companyX,
      y: companyNameBaselineY - 42,
      font,
      size: 8,
      color: gray,
    });
    page.drawText(INVOICE_COMPANY.email, {
      x: companyX,
      y: companyNameBaselineY - 54,
      font,
      size: 8,
      color: gray,
    });

    if (appEnv === "test") {
      page.drawText("TEST", {
        x: rightMargin - 34,
        y: headerTopY - 4,
        font: fontBold,
        size: 14,
        color: rgb(0.88, 0.18, 0.18),
      });
    }

    let metaY = headerTopY - 4;
    drawMetadataRow(page, "Fakturanummer", invoice.invoice_number || "—", metaY, font, fontBold, metaLabelX, metaValueRightX, gray, black);
    metaY -= 13;
    drawMetadataRow(page, "Fakturadatum", formatDate(invoice.issued_at || invoice.finalized_at), metaY, font, fontBold, metaLabelX, metaValueRightX, gray, black);
    metaY -= 13;
    drawMetadataRow(page, "Förfallodatum", formatDate(invoice.due_date), metaY, font, fontBold, metaLabelX, metaValueRightX, gray, black);
    if (invoice.quote_number) {
      metaY -= 13;
      drawMetadataRow(page, "Offertnummer", invoice.quote_number, metaY, font, fontBold, metaLabelX, metaValueRightX, gray, black);
    }

    let y = height - 164;
    page.drawText("FAKTURA", {
      x: leftMargin,
      y,
      font: fontBold,
      size: 24,
      color: brandBlue,
    });

    y -= 28;

    const boxTopY = y;
    const boxHeight = 104;
    const sellerBoxWidth = 222;
    const customerBoxX = 300;
    const customerBoxWidth = rightMargin - customerBoxX;

    page.drawRectangle({
      x: leftMargin,
      y: boxTopY - boxHeight,
      width: sellerBoxWidth,
      height: boxHeight,
      color: softGray,
      borderColor: lightGray,
      borderWidth: 1,
    });
    page.drawRectangle({
      x: customerBoxX,
      y: boxTopY - boxHeight,
      width: customerBoxWidth,
      height: boxHeight,
      color: softGray,
      borderColor: lightGray,
      borderWidth: 1,
    });

    page.drawText("Avsändare", {
      x: leftMargin + 12,
      y: boxTopY - 15,
      font: fontBold,
      size: 9,
      color: gray,
    });
    page.drawText("Kund", {
      x: customerBoxX + 12,
      y: boxTopY - 15,
      font: fontBold,
      size: 9,
      color: gray,
    });

    let sellerY = boxTopY - 32;
    page.drawText(INVOICE_COMPANY.name, {
      x: leftMargin + 12,
      y: sellerY,
      font: fontBold,
      size: 10,
      color: black,
    });
    sellerY -= 14;
    page.drawText(`Org.nr: ${INVOICE_COMPANY.orgNumber}`, { x: leftMargin + 12, y: sellerY, font, size: 8.5, color: black });
    sellerY -= 11;
    page.drawText(`VAT nr: ${INVOICE_COMPANY.vatNumber}`, { x: leftMargin + 12, y: sellerY, font, size: 8.5, color: black });
    sellerY -= 11;
    page.drawText(`Adress: ${INVOICE_COMPANY.street}`, { x: leftMargin + 12, y: sellerY, font, size: 8.5, color: black });
    sellerY -= 11;
    page.drawText(`Postnr/Ort: ${INVOICE_COMPANY.postcode} ${INVOICE_COMPANY.city}`, {
      x: leftMargin + 12,
      y: sellerY,
      font,
      size: 8.5,
      color: black,
    });
    sellerY -= 11;
    page.drawText(INVOICE_COMPANY.email, { x: leftMargin + 12, y: sellerY, font, size: 8.5, color: gray });

    let customerY = boxTopY - 32;
    page.drawText(invoice.customer_name || "—", {
      x: customerBoxX + 12,
      y: customerY,
      font: fontBold,
      size: 10,
      color: black,
    });
    customerY -= 14;
    page.drawText(`Adress: ${invoice.customer_address?.street || "—"}`, {
      x: customerBoxX + 12,
      y: customerY,
      font,
      size: 8.5,
      color: black,
    });
    customerY -= 11;
    page.drawText(`Postnr/Ort: ${customerPostcodeCity}`, {
      x: customerBoxX + 12,
      y: customerY,
      font,
      size: 8.5,
      color: black,
    });

    y = boxTopY - boxHeight - 24;

    page.drawRectangle({
      x: leftMargin,
      y: y - 2,
      width: contentWidth,
      height: 18,
      color: rgb(0.94, 0.96, 0.98),
    });
    page.drawText("Beskrivning", { x: leftMargin + 6, y: y + 2, font: fontBold, size: 8, color: gray });
    page.drawText("Antal", { x: 332, y: y + 2, font: fontBold, size: 8, color: gray });
    page.drawText("á-pris", { x: 382, y: y + 2, font: fontBold, size: 8, color: gray });
    page.drawText("Moms", { x: 444, y: y + 2, font: fontBold, size: 8, color: gray });
    page.drawText("Belopp", { x: 492, y: y + 2, font: fontBold, size: 8, color: gray });

    y -= 20;

    for (const item of invoice.line_items) {
      if (y < 250) break;

      const quantity = item.quantity || 1;
      const unitPrice = item.unit_price || 0;
      const lineTotal = quantity * unitPrice;
      let description = item.description || "";

      if (description.length > 58) {
        description = description.slice(0, 55) + "...";
      }

      page.drawText(description, {
        x: leftMargin + 6,
        y,
        font,
        size: 8,
        color: black,
        maxWidth: 285,
      });
      drawRightAlignedText(page, formatQuantity(quantity), 360, y, font, 8, black);
      drawRightAlignedText(page, formatSEK(unitPrice), 434, y, font, 8, black);
      drawRightAlignedText(page, `${item.tax_rate || 25}%`, 476, y, font, 8, black);
      drawRightAlignedText(page, formatSEK(lineTotal), rightMargin - 6, y, font, 8, black);

      y -= 14;
    }

    y -= 6;
    page.drawLine({
      start: { x: leftMargin, y },
      end: { x: rightMargin, y },
      thickness: 0.6,
      color: lightGray,
    });

    const totalsX = 392;
    const amountRightX = rightMargin - 6;
    const subtotal = invoice.subtotal || 0;
    const tax = invoice.tax || 0;
    const total = invoice.total || 0;

    let totalsY = y - 18;
    page.drawText("Summa exkl. moms", { x: totalsX, y: totalsY, font, size: 9, color: gray });
    drawRightAlignedText(page, formatSEK(subtotal), amountRightX, totalsY, font, 9, black);
    totalsY -= 14;
    page.drawText("Moms", { x: totalsX, y: totalsY, font, size: 9, color: gray });
    drawRightAlignedText(page, formatSEK(tax), amountRightX, totalsY, font, 9, black);
    totalsY -= 16;
    page.drawLine({
      start: { x: totalsX, y: totalsY + 10 },
      end: { x: rightMargin, y: totalsY + 10 },
      thickness: 0.6,
      color: lightGray,
    });
    page.drawText("Att betala", { x: totalsX, y: totalsY, font: fontBold, size: 11, color: black });
    drawRightAlignedText(page, formatSEK(total), amountRightX, totalsY, fontBold, 11, black);

    const paymentTopY = totalsY - 40;
    page.drawLine({
      start: { x: leftMargin, y: paymentTopY + 18 },
      end: { x: rightMargin, y: paymentTopY + 18 },
      thickness: 0.6,
      color: lightGray,
    });

    page.drawText("Betalningsinformation", {
      x: leftMargin,
      y: paymentTopY,
      font: fontBold,
      size: 10,
      color: black,
    });

    let paymentY = paymentTopY - 18;
    page.drawText("Bankgiro", { x: leftMargin, y: paymentY, font, size: 9, color: gray });
    page.drawText(invoice.payment_details.bankgiro_number || "Ej konfigurerat", {
      x: leftMargin + 104,
      y: paymentY,
      font: fontBold,
      size: 9,
      color: black,
    });
    paymentY -= 14;
    page.drawText("Betalningsref.", { x: leftMargin, y: paymentY, font, size: 9, color: gray });
    page.drawText(invoice.payment_details.payment_reference || "—", {
      x: leftMargin + 104,
      y: paymentY,
      font: fontBold,
      size: 9,
      color: black,
    });
    paymentY -= 14;
    page.drawText("Belopp", { x: leftMargin, y: paymentY, font, size: 9, color: gray });
    page.drawText(formatSEK(invoice.payment_details.amount), {
      x: leftMargin + 104,
      y: paymentY,
      font: fontBold,
      size: 9,
      color: black,
    });
    paymentY -= 14;
    page.drawText("Förfallodatum", { x: leftMargin, y: paymentY, font, size: 9, color: gray });
    page.drawText(formatDate(invoice.payment_details.due_date), {
      x: leftMargin + 104,
      y: paymentY,
      font: fontBold,
      size: 9,
      color: black,
    });
    paymentY -= 14;
    page.drawText("Mottagare", { x: leftMargin, y: paymentY, font, size: 9, color: gray });
    page.drawText(invoice.payment_details.payee_name, {
      x: leftMargin + 104,
      y: paymentY,
      font: fontBold,
      size: 9,
      color: black,
    });

    if (invoice.payment_details.qr_data_url) {
      const qrImage = await pdfDoc.embedPng(dataUrlToBytes(invoice.payment_details.qr_data_url));
      page.drawRectangle({
        x: rightMargin - 92,
        y: paymentTopY - 56,
        width: 78,
        height: 78,
        color: white,
        borderColor: lightGray,
        borderWidth: 1,
      });
      page.drawImage(qrImage, {
        x: rightMargin - 89,
        y: paymentTopY - 53,
        width: 72,
        height: 72,
      });
    }

    page.drawText(invoice.payment_details.manual_payment_instruction, {
      x: leftMargin,
      y: paymentY - 22,
      font,
      size: 8,
      color: gray,
      maxWidth: 360,
      lineHeight: 10,
    });

    if (invoice.status === "paid") {
      page.drawText("BETALD", {
        x: 182,
        y: 396,
        font: fontBold,
        size: 58,
        color: rgb(0.0, 0.55, 0.12),
        opacity: 0.15,
        rotate: degrees(45),
      });
    } else if (invoice.status === "void") {
      page.drawText("MAKULERAD", {
        x: 136,
        y: 398,
        font: fontBold,
        size: 50,
        color: rgb(0.8, 0.0, 0.0),
        opacity: 0.15,
        rotate: degrees(45),
      });
    }

    const pdfBytes = await pdfDoc.save();
    logStep("PDF generated", { bytes: pdfBytes.length });

    const filename = `Faktura-${invoice.invoice_number || invoice.id}.pdf`;

    return new Response(pdfBytes as unknown as BodyInit, {
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
