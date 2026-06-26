import { serve } from "https://deno.land/std@0.190.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.57.2";
import { PDFDocument, StandardFonts, degrees, rgb, type PDFPage, type PDFFont } from "https://esm.sh/pdf-lib@1.17.1";
import { getAppEnvironment } from "../_shared/app-env.ts";
import { loadBusinessSettings } from "../_shared/invoice-company.ts";
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
  brandBlue: ReturnType<typeof rgb>,
  white: ReturnType<typeof rgb>,
) {
  const scale = Math.min(width / 74, height / 68);

  page.drawSvgPath("M0 15C0 6.71573 6.71573 0 15 0H59C67.2843 0 74 6.71573 74 15V53C74 61.2843 67.2843 68 59 68H15C6.71573 68 0 61.2843 0 53V15Z", {
    x,
    y,
    scale,
    color: brandBlue,
  });

  for (const path of [
    "M18.4882 43.1925C17.2432 43.1925 16.1459 42.9956 15.1962 42.6019C14.2545 42.1999 13.5043 41.6298 12.9457 40.8915C12.395 40.1532 12.0838 39.2796 12.012 38.2706L12 38.0983H14.1547L14.1787 38.2706C14.2665 38.8612 14.5019 39.3739 14.885 39.8087C15.268 40.2353 15.7748 40.5675 16.4052 40.8054C17.0437 41.0351 17.7779 41.1499 18.6079 41.1499C19.4378 41.1499 20.1561 41.031 20.7626 40.7931C21.3691 40.547 21.836 40.1983 22.1632 39.7472C22.4984 39.296 22.666 38.7669 22.666 38.1599V38.1476C22.666 37.3683 22.4026 36.7448 21.8759 36.2772C21.3492 35.8097 20.4913 35.4405 19.3022 35.1698L17.3868 34.7392C15.703 34.3536 14.454 33.763 13.64 32.9673C12.834 32.1634 12.4309 31.1134 12.4309 29.8173V29.805C12.4389 28.8288 12.7023 27.9716 13.221 27.2333C13.7398 26.4868 14.454 25.9044 15.3638 25.486C16.2815 25.0595 17.331 24.8462 18.5121 24.8462C19.6374 24.8462 20.6429 25.0554 21.5287 25.4737C22.4146 25.8839 23.1208 26.4581 23.6476 27.1964C24.1823 27.9347 24.4815 28.7878 24.5454 29.7558L24.5573 29.9403H22.4026L22.3787 29.7681C22.2909 29.161 22.0754 28.6442 21.7322 28.2177C21.3891 27.7911 20.9382 27.463 20.3795 27.2333C19.8289 27.0036 19.1865 26.8888 18.4522 26.8888C17.6861 26.8888 17.0158 27.0077 16.4412 27.2456C15.8666 27.4835 15.4196 27.8157 15.1004 28.2423C14.7892 28.6688 14.6336 29.1692 14.6336 29.7435V29.7558C14.6336 30.4776 14.9009 31.0724 15.4356 31.5399C15.9703 32.0075 16.8003 32.3685 17.9255 32.6228L19.8409 33.0534C21.022 33.3159 21.9796 33.6646 22.7138 34.0993C23.456 34.5341 23.9987 35.0755 24.3419 35.7235C24.693 36.3634 24.8686 37.1345 24.8686 38.0368V38.0491C24.8686 39.0991 24.6092 40.0097 24.0905 40.7808C23.5797 41.5519 22.8455 42.1466 21.8879 42.5649C20.9382 42.9833 19.8049 43.1925 18.4882 43.1925Z",
    "M29.846 42.8972V25.1415H32.0008V32.8196H41.4816V25.1415H43.6363V42.8972H41.4816V34.813H32.0008V42.8972H29.846Z",
    "M55.09 43.1925C53.845 43.1925 52.7477 42.9956 51.798 42.6019C50.8563 42.1999 50.1062 41.6298 49.5475 40.8915C48.9969 40.1532 48.6856 39.2796 48.6138 38.2706L48.6018 38.0983H50.7566L50.7805 38.2706C50.8683 38.8612 51.1037 39.3739 51.4868 39.8087C51.8698 40.2353 52.3766 40.5675 53.0071 40.8054C53.6455 41.0351 54.3797 41.1499 55.2097 41.1499C56.0397 41.1499 56.7579 41.031 57.3644 40.7931C57.9709 40.547 58.4378 40.1983 58.765 39.7472C59.1002 39.296 59.2678 38.7669 59.2678 38.1599V38.1476C59.2678 37.3683 59.0044 36.7448 58.4777 36.2772C57.951 35.8097 57.0931 35.4405 55.904 35.1698L53.9887 34.7392C52.3048 34.3536 51.0558 33.763 50.2418 32.9673C49.4358 32.1634 49.0328 31.1134 49.0328 29.8173V29.805C49.0408 28.8288 49.3041 27.9716 49.8228 27.2333C50.3416 26.4868 51.0558 25.9044 51.9656 25.486C52.8834 25.0595 53.9328 24.8462 55.1139 24.8462C56.2392 24.8462 57.2447 25.0554 58.1306 25.4737C59.0164 25.8839 59.7227 26.4581 60.2494 27.1964C60.7841 27.9347 61.0833 28.7878 61.1472 29.7558L61.1592 29.9403H59.0044L58.9805 29.7681C58.8927 29.161 58.6772 28.6442 58.3341 28.2177C57.9909 27.7911 57.54 27.463 56.9814 27.2333C56.4307 27.0036 55.7883 26.8888 55.0541 26.8888C54.2879 26.8888 53.6176 27.0077 53.043 27.2456C52.4684 27.4835 52.0215 27.8157 51.7023 28.2423C51.391 28.6688 51.2354 29.1692 51.2354 29.7435V29.7558C51.2354 30.4776 51.5027 31.0724 52.0374 31.5399C52.5721 32.0075 53.4021 32.3685 54.5274 32.6228L56.4427 33.0534C57.6238 33.3159 58.5815 33.6646 59.3157 34.0993C60.0578 34.5341 60.6005 35.0755 60.9437 35.7235C61.2948 36.3634 61.4704 37.1345 61.4704 38.0368V38.0491C61.4704 39.0991 61.211 40.0097 60.6923 40.7808C60.1815 41.5519 59.4473 42.1466 58.4897 42.5649C57.54 42.9833 56.4068 43.1925 55.09 43.1925Z",
  ]) {
    page.drawSvgPath(path, {
      x,
      y,
      scale,
      color: white,
    });
    page.drawSvgPath(path, {
      x,
      y,
      scale,
      borderColor: white,
      borderWidth: 2 * scale,
      opacity: 1,
    });
  }

  page.drawSvgPath("M40.4594 5.23077L5.33337 24.4094V30.7308C5.33337 35.9877 7.53638 41.7831 11.3334 45.4423C17.5988 51.4804 25.4718 53.7654 33.3334 55.5769V62.7692C45 59.1731 55 53.6154 61.3334 47.0769C65.5022 42.4128 68.6667 36.9697 68.6667 30.7308V24.4094L40.4594 12.4521V5.23077Z", {
    x,
    y,
    scale,
    borderColor: white,
    borderWidth: 4 * scale,
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
    const company = await loadBusinessSettings(serviceClient);
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

    const logoWidth = 74;
    const logoHeight = 68;
    const logoTopOffset = 4;
    const headerTopY = height - 48;
    const companyNameSize = 18;
    const companyNameBaselineY = headerTopY - 12;
    const companyNameTopY = companyNameBaselineY + companyNameSize;

    drawShsLogo(page, leftMargin, companyNameTopY - logoTopOffset, logoWidth, logoHeight, brandBlue, white);

    const companyX = leftMargin + logoWidth + 16;
    page.drawText(company.name, {
      x: companyX,
      y: companyNameBaselineY,
      font: fontBold,
      size: companyNameSize,
      color: black,
    });
    const tagline = "Make your home work for you";
    page.drawText(tagline, {
      x: companyX,
      y: companyNameBaselineY - 16 - 4,
      font,
      size: 12,
      color: gray,
    });

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

    if (appEnv === "test") {
      page.drawText("TEST", {
        x: leftMargin + fontBold.widthOfTextAtSize("FAKTURA", 24) + 14,
        y,
        font: fontBold,
        size: 24,
        color: rgb(0.88, 0.18, 0.18),
      });
    }

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
    page.drawText(company.name, {
      x: leftMargin + 12,
      y: sellerY,
      font: fontBold,
      size: 10,
      color: black,
    });
    sellerY -= 14;
    page.drawText(`Org.nr: ${company.orgNumber}`, { x: leftMargin + 12, y: sellerY, font, size: 8.5, color: black });
    sellerY -= 11;
    page.drawText(`VAT nr: ${company.vatNumber}`, { x: leftMargin + 12, y: sellerY, font, size: 8.5, color: black });
    sellerY -= 11;
    page.drawText(`Adress: ${company.street}`, { x: leftMargin + 12, y: sellerY, font, size: 8.5, color: black });
    sellerY -= 11;
    page.drawText(`Postnr/Ort: ${company.postcode} ${company.city}`, {
      x: leftMargin + 12,
      y: sellerY,
      font,
      size: 8.5,
      color: black,
    });
    sellerY -= 11;
    page.drawText(company.email, { x: leftMargin + 12, y: sellerY, font, size: 8.5, color: gray });

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
