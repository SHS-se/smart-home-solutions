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

  async function read(): Promise<string> {
    const buf = new Uint8Array(4096);
    const n = await conn.read(buf);
    if (n === null) throw new Error("Connection closed");
    return decoder.decode(buf.subarray(0, n));
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
    const greeting = await read();
    console.log("Greeting:", greeting);

    // EHLO
    let response = await writeAndRead(`EHLO client`);
    console.log("EHLO response:", response);

    // STARTTLS
    response = await writeAndRead("STARTTLS");
    console.log("STARTTLS response:", response);

    if (!response.startsWith("220")) {
      throw new Error(`STARTTLS failed: ${response}`);
    }

    // Upgrade to TLS
    const tlsConn = await Deno.startTls(conn, { hostname: host });

    async function tlsRead(): Promise<string> {
      const buf = new Uint8Array(4096);
      const n = await tlsConn.read(buf);
      if (n === null) throw new Error("Connection closed");
      return decoder.decode(buf.subarray(0, n));
    }

    async function tlsWrite(cmd: string): Promise<void> {
      await tlsConn.write(encoder.encode(cmd + "\r\n"));
    }

    async function tlsWriteAndRead(cmd: string): Promise<string> {
      await tlsWrite(cmd);
      return await tlsRead();
    }

    // EHLO again after TLS
    response = await tlsWriteAndRead(`EHLO client`);
    console.log("EHLO after TLS:", response);

    // AUTH LOGIN
    response = await tlsWriteAndRead("AUTH LOGIN");
    console.log("AUTH LOGIN response:", response);

    // Send username (base64)
    response = await tlsWriteAndRead(btoa(username));
    console.log("Username response:", response);

    // Send password (base64)
    response = await tlsWriteAndRead(btoa(password));
    console.log("Password response:", response);

    if (!response.startsWith("235")) {
      throw new Error(`Authentication failed: ${response}`);
    }

    // MAIL FROM
    response = await tlsWriteAndRead(`MAIL FROM:<${from}>`);
    console.log("MAIL FROM response:", response);

    // RCPT TO
    response = await tlsWriteAndRead(`RCPT TO:<${to}>`);
    console.log("RCPT TO response:", response);

    // DATA
    response = await tlsWriteAndRead("DATA");
    console.log("DATA response:", response);

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

    // QUIT
    await tlsWrite("QUIT");
    tlsConn.close();

  } catch (error) {
    conn.close();
    throw error;
  }
}

const handler = async (req: Request): Promise<Response> => {
  if (req.method === "OPTIONS") {
    return new Response(null, { headers: corsHeaders });
  }

  try {
    const { name, email, phone, message }: ContactEmailRequest = await req.json();

    const smtpHost = Deno.env.get("SMTP_HOST") || "smtp.protonmail.ch";
    const smtpPort = parseInt(Deno.env.get("SMTP_PORT") || "587");
    const smtpUser = Deno.env.get("SMTP_USER")!;
    const smtpPass = Deno.env.get("SMTP_PASS")!;

    const htmlBody = `
      <h2>Nytt meddelande från kontaktformuläret</h2>
      <p><strong>Namn:</strong> ${name}</p>
      <p><strong>E-post:</strong> ${email}</p>
      <p><strong>Telefon:</strong> ${phone || 'Ej angiven'}</p>
      <hr />
      <h3>Meddelande:</h3>
      <p>${message.replace(/\n/g, '<br>')}</p>
    `;

    await sendEmailViaSMTP(
      smtpHost,
      smtpPort,
      smtpUser,
      smtpPass,
      "noreply@smarthomesolutions.se",
      "sales@smarthomesolutions.se",
      email,
      `Nytt kontaktformulär: ${name}`,
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
