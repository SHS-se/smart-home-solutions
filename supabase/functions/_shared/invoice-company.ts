import type { SupabaseClient } from "https://esm.sh/@supabase/supabase-js@2.57.2";

/** Hard-coded defaults, used as a fallback when the business_settings row is
 *  missing or a field is blank. Kept in sync with the migration seed. */
export const INVOICE_COMPANY = {
  name: "Smart Home Solutions",
  orgNumber: "790519-7591",
  vatNumber: "SE790519759101",
  email: "support@smarthomesolutions.se",
  street: "Porfyrvägen 10",
  postcode: "187 34",
  city: "Täby",
} as const;

/** Resolved company/payment/contact details for rendering invoices and emails. */
export interface BusinessSettings {
  name: string;
  orgNumber: string;
  vatNumber: string;
  fSkattApproved: boolean;
  street: string;
  postcode: string;
  city: string;
  country: string;
  email: string;
  supportEmail: string;
  phone: string;
  website: string;
  bankgiroNumber: string | null;
  payeeName: string;
  iban: string | null;
  bic: string | null;
  bankName: string | null;
  paymentTermsDays: number;
}

function nonEmpty(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

/** Defaults derived from the hard-coded company constant. */
function defaultBusinessSettings(): BusinessSettings {
  return {
    name: INVOICE_COMPANY.name,
    orgNumber: INVOICE_COMPANY.orgNumber,
    vatNumber: INVOICE_COMPANY.vatNumber,
    fSkattApproved: true,
    street: INVOICE_COMPANY.street,
    postcode: INVOICE_COMPANY.postcode,
    city: INVOICE_COMPANY.city,
    country: "Sverige",
    email: INVOICE_COMPANY.email,
    supportEmail: INVOICE_COMPANY.email,
    phone: "",
    website: "",
    // Legacy fallback: the bankgiro used to come from an edge-function secret.
    bankgiroNumber: nonEmpty(Deno.env.get("BANKGIRO_NUMBER")),
    payeeName: INVOICE_COMPANY.name,
    iban: null,
    bic: null,
    bankName: null,
    paymentTermsDays: 30,
  };
}

/**
 * Loads the singleton business_settings row and merges it over the hard-coded
 * defaults so a missing row or blank field never breaks invoice rendering.
 * Reads with the provided client (service role in edge functions, bypassing RLS).
 */
export async function loadBusinessSettings(
  client: SupabaseClient,
): Promise<BusinessSettings> {
  const defaults = defaultBusinessSettings();
  try {
    const { data, error } = await client
      .from("business_settings")
      .select("*")
      .eq("id", 1)
      .maybeSingle();
    if (error || !data) return defaults;

    const row = data as Record<string, unknown>;
    return {
      name: nonEmpty(row.legal_name) ?? defaults.name,
      orgNumber: nonEmpty(row.org_number) ?? defaults.orgNumber,
      vatNumber: nonEmpty(row.vat_number) ?? defaults.vatNumber,
      fSkattApproved: row.f_skatt_approved !== false,
      street: nonEmpty(row.address_street) ?? defaults.street,
      postcode: nonEmpty(row.address_postcode) ?? defaults.postcode,
      city: nonEmpty(row.address_city) ?? defaults.city,
      country: nonEmpty(row.address_country) ?? defaults.country,
      email: nonEmpty(row.contact_email) ?? defaults.email,
      supportEmail: nonEmpty(row.support_email) ?? nonEmpty(row.contact_email) ?? defaults.supportEmail,
      phone: nonEmpty(row.contact_phone) ?? defaults.phone,
      website: nonEmpty(row.website) ?? defaults.website,
      bankgiroNumber: nonEmpty(row.bankgiro_number) ?? defaults.bankgiroNumber,
      payeeName: nonEmpty(row.payee_name) ?? nonEmpty(row.legal_name) ?? defaults.payeeName,
      iban: nonEmpty(row.iban),
      bic: nonEmpty(row.bic),
      bankName: nonEmpty(row.bank_name),
      paymentTermsDays:
        typeof row.payment_terms_days === "number" && Number.isFinite(row.payment_terms_days)
          ? row.payment_terms_days
          : defaults.paymentTermsDays,
    };
  } catch {
    return defaults;
  }
}
