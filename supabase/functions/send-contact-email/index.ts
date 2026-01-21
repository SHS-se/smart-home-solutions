import { serve } from "https://deno.land/std@0.190.0/http/server.ts";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type",
};

interface ContactEmailRequest {
  name: string;
  email: string;
  phone?: string;
  message: string;
}

async function sendEmailViaSMTP(
  host: string,
  port: number,
  username: string,
  password: string,
  from: string,
  to: string,
  replyTo: string,
  subject: string,
  htmlBody: string
): Promise<void> {
  const encoder = new TextEncoder();
  const decoder = new TextDecoder();

  // Connect to SMTP server
  const conn = await Deno.connect({ hostname: host, port });
  let tlsConn: Deno.TlsConn | null = null;
  let tlsClosed = false;

  const safeClose = (c: { close: () => void } | null) => {
    if (!c) return;
    try {
      c.close();
    } catch (_e) {
      // Ignore close errors; we want to preserve the original failure cause.
    }
  };

  async function read(): Promise<string> {
    const buf = new Uint8Array(4096);
    const n = await conn.read(buf);
    if (n === null) throw new Error("Connection closed");
    return decoder.decode(buf.subarray(0, n));
  }

  // Best-effort read for multi-line SMTP responses (e.g. EHLO)
  async function readSmtpResponse(readFn: () => Promise<string>): Promise<string> {
    let acc = "";
    // limit loops to avoid hanging
    for (let i = 0; i < 10; i++) {
      const chunk = await readFn();
      acc += chunk;
      // SMTP multiline responses end with: "XYZ <text>" (space after code)
      const lines = acc.split("\r\n").filter(Boolean);
      const last = lines[lines.length - 1] || "";
      if (/^\d{3} /.test(last)) return acc;
      // If we don't even have CRLF yet, keep reading.
      if (!acc.includes("\r\n")) continue;
    }
    return acc;
  }

  function assertSmtpOk(step: string, response: string, okCodes: string[]) {
    const trimmed = response.trim();
    const code = trimmed.slice(0, 3);
    if (!okCodes.includes(code)) {
      throw new Error(`${step} failed: ${trimmed}`);
    }
  }

  async function write(cmd: string): Promise<void> {
    await conn.write(encoder.encode(cmd + "\r\n"));
  }

  async function writeAndRead(cmd: string): Promise<string> {
    await write(cmd);
    return await read();
  }

  try {
    // Read greeting
    const greeting = await readSmtpResponse(read);
    console.log("Greeting:", greeting);

    // EHLO
    let response = await readSmtpResponse(() => writeAndRead(`EHLO client`));
    console.log("EHLO response:", response);

    // STARTTLS
    response = await writeAndRead("STARTTLS");
    console.log("STARTTLS response:", response);
    assertSmtpOk("STARTTLS", response, ["220"]);

    // Upgrade to TLS
    tlsConn = await Deno.startTls(conn, { hostname: host });
    const tls = tlsConn;

    async function tlsRead(): Promise<string> {
      const buf = new Uint8Array(4096);
      const n = await tls.read(buf);
      if (n === null) throw new Error("Connection closed");
      return decoder.decode(buf.subarray(0, n));
    }

    async function tlsReadSmtp(): Promise<string> {
      return await readSmtpResponse(tlsRead);
    }

    async function tlsWrite(cmd: string): Promise<void> {
      await tls.write(encoder.encode(cmd + "\r\n"));
    }

    async function tlsWriteAndRead(cmd: string): Promise<string> {
      await tlsWrite(cmd);
      return await tlsReadSmtp();
    }

    // EHLO again after TLS
    response = await tlsWriteAndRead(`EHLO client`);
    console.log("EHLO after TLS:", response);

    // AUTH LOGIN
    response = await tlsWriteAndRead("AUTH LOGIN");
    console.log("AUTH LOGIN response:", response);
    assertSmtpOk("AUTH LOGIN", response, ["334"]);

    // Send username (base64)
    response = await tlsWriteAndRead(btoa(username));
    console.log("Username response:", response);
    assertSmtpOk("AUTH username", response, ["334"]);

    // Send password (base64)
    response = await tlsWriteAndRead(btoa(password));
    console.log("Password response:", response);
    assertSmtpOk("AUTH password", response, ["235"]);

    // MAIL FROM
    console.log("Envelope:", { from, to });
    response = await tlsWriteAndRead(`MAIL FROM:<${from}>`);
    console.log("MAIL FROM response:", response);
    assertSmtpOk("MAIL FROM", response, ["250"]);

    // RCPT TO
    response = await tlsWriteAndRead(`RCPT TO:<${to}>`);
    console.log("RCPT TO response:", response);
    assertSmtpOk("RCPT TO", response, ["250", "251"]);

    // DATA
    response = await tlsWriteAndRead("DATA");
    console.log("DATA response:", response);
    assertSmtpOk("DATA", response, ["354"]);

    // Email content
    const boundary = `----=_Part_${Date.now()}`;
    const emailContent = [
      `From: Smart Home Solutions <${from}>`,
      `To: ${to}`,
      `Reply-To: ${replyTo}`,
      `Subject: ${subject}`,
      `MIME-Version: 1.0`,
      `Content-Type: multipart/alternative; boundary="${boundary}"`,
      ``,
      `--${boundary}`,
      `Content-Type: text/html; charset=utf-8`,
      `Content-Transfer-Encoding: 7bit`,
      ``,
      htmlBody,
      ``,
      `--${boundary}--`,
      `.`
    ].join("\r\n");

    response = await tlsWriteAndRead(emailContent);
    console.log("Email send response:", response);
    assertSmtpOk("Email body", response, ["250"]);

    // QUIT
    await tlsWrite("QUIT");
    safeClose(tlsConn);
    tlsClosed = true;

  } catch (error) {
    throw error;
  } finally {
    // If TLS was established, the TLS connection owns the underlying socket.
    if (tlsConn) {
      if (!tlsClosed) safeClose(tlsConn);
    } else {
      safeClose(conn);
    }
  }
}

function extractEmailAddress(value: string): string {
  const trimmed = value.trim();
  const match = trimmed.match(/<([^>]+)>/);
  return (match?.[1] ?? trimmed).trim();
}

function assertEmailAddress(label: string, value: string): void {
  // Simple sanity check (we don't need full RFC compliance here)
  const ok = /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value);
  if (!ok) {
    throw new Error(
      `${label} must be a full email address like name@domain.tld (check your backend secret).`
    );
  }
}

// HTML escape to prevent XSS in email content
function escapeHtml(unsafe: string): string {
  return unsafe
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#039;");
}

const handler = async (req: Request): Promise<Response> => {
  if (req.method === "OPTIONS") {
    return new Response(null, { headers: corsHeaders });
  }

  try {
    const { name, email, phone, message }: ContactEmailRequest = await req.json();

    const smtpHost = Deno.env.get("SMTP_HOST") || "smtp.protonmail.ch";
    const smtpPort = parseInt(Deno.env.get("SMTP_PORT") || "587");
    const smtpUserRaw = Deno.env.get("SMTP_USER");
    const smtpPass = Deno.env.get("SMTP_PASS");
    if (!smtpUserRaw || !smtpPass) {
      throw new Error(
        "Missing SMTP credentials (SMTP_USER/SMTP_PASS). Please configure backend secrets."
      );
    }
    const smtpUser = extractEmailAddress(smtpUserRaw);

    // Proton SMTP commonly rejects envelope sender addresses that aren't owned/allowed by the authenticated user.
    // Default the FROM to the authenticated account, while keeping the user's address in Reply-To.
    const fromAddress = extractEmailAddress(Deno.env.get("SMTP_FROM") || smtpUser);
    const toAddress = extractEmailAddress(Deno.env.get("CONTACT_TO") || smtpUser);
    assertEmailAddress("SMTP_FROM", fromAddress);
    assertEmailAddress("CONTACT_TO", toAddress);

    // Sanitize all user inputs to prevent HTML injection / XSS
    const safeName = escapeHtml(name);
    const safeEmail = escapeHtml(email);
    const safePhone = escapeHtml(phone || "Ej angiven");
    const safeMessage = escapeHtml(message).replace(/\n/g, "<br>");

    const htmlBody = `
      <h2>Nytt meddelande från kontaktformuläret</h2>
      <p><strong>Namn:</strong> ${safeName}</p>
      <p><strong>E-post:</strong> ${safeEmail}</p>
      <p><strong>Telefon:</strong> ${safePhone}</p>
      <hr />
      <h3>Meddelande:</h3>
      <p>${safeMessage}</p>
    `;

    await sendEmailViaSMTP(
      smtpHost,
      smtpPort,
      smtpUser,
      smtpPass,
      fromAddress,
      toAddress,
      email,
      `Nytt kontaktformulär: ${safeName}`,
      htmlBody
    );

    console.log("Email sent successfully via SMTP");

    return new Response(JSON.stringify({ success: true }), {
      status: 200,
      headers: { "Content-Type": "application/json", ...corsHeaders },
    });
  } catch (error: any) {
    console.error("Error in send-contact-email function:", error);
    return new Response(
      JSON.stringify({ error: error.message }),
      {
        status: 500,
        headers: { "Content-Type": "application/json", ...corsHeaders },
      }
    );
  }
};

serve(handler);
