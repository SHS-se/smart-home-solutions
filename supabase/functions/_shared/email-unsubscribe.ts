// List-Unsubscribe headers and the shared customer-email footer.
//
// Quote/invoice mail is transactional and always sent; the unsubscribe link
// only ends marketing mail ("nyheter och erbjudanden"). Carrying the RFC 8058
// one-click headers and a legal footer on transactional mail is a
// deliverability signal that Gmail/Outlook reward.
import type { BusinessSettings } from "./invoice-company.ts";

export interface UnsubscribeInfo {
  /** Extra headers for resend.emails.send (RFC 8058 one-click unsubscribe). */
  headers: Record<string, string>;
  /** Human-facing preference page, for the email footer link. */
  pageUrl: string;
}

export function buildUnsubscribeInfo(appOrigin: string, unsubscribeToken: string): UnsubscribeInfo {
  const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
  const oneClickUrl = `${supabaseUrl}/functions/v1/unsubscribe?token=${unsubscribeToken}`;
  return {
    headers: {
      "List-Unsubscribe": `<${oneClickUrl}>`,
      "List-Unsubscribe-Post": "List-Unsubscribe=One-Click",
    },
    pageUrl: `${appOrigin}/unsubscribe?token=${unsubscribeToken}`,
  };
}

/** Footer <tr> for the standard 560px email table: support contact, legal
 *  identity, and (when a token is available) the marketing unsubscribe link. */
export function buildEmailFooterHtml(
  company: BusinessSettings,
  unsubscribe: UnsubscribeInfo | null,
): string {
  const address = `${company.street}, ${company.postcode} ${company.city}`;
  return `<tr><td style="padding:24px;border-top:1px solid #e8e8ef;">
  <p style="margin:0;font-size:13px;color:#8a8aa0;text-align:center;line-height:1.5;">
    Har du frågor? Kontakta oss på<br>
    <a href="mailto:${company.supportEmail}" style="color:#3b82f6;text-decoration:none;">${company.supportEmail}</a>
  </p>
  <p style="margin:12px 0 0;font-size:12px;color:#a0a0b8;text-align:center;line-height:1.5;">
    ${company.name} · Org.nr ${company.orgNumber} · ${address}
  </p>${unsubscribe ? `
  <p style="margin:12px 0 0;font-size:12px;color:#a0a0b8;text-align:center;line-height:1.5;">
    Vill du inte få nyheter och erbjudanden från oss?
    <a href="${unsubscribe.pageUrl}" style="color:#8a8aa0;">Avsluta marknadsutskick</a>
  </p>` : ""}
</td></tr>`;
}

export function buildEmailFooterText(
  company: BusinessSettings,
  unsubscribe: UnsubscribeInfo | null,
): string {
  const address = `${company.street}, ${company.postcode} ${company.city}`;
  let text = `Frågor? Kontakta oss: ${company.supportEmail}\n`;
  text += `${company.name} · Org.nr ${company.orgNumber} · ${address}\n`;
  if (unsubscribe) {
    text += `\nVill du inte få nyheter och erbjudanden från oss? Avsluta marknadsutskick: ${unsubscribe.pageUrl}\n`;
  }
  return text;
}
