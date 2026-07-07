import { useQuery } from '@tanstack/react-query';
import { supabase } from '@/integrations/supabase/client';
import type { Database } from '@/integrations/supabase/types';

export type BusinessSettings = Database['public']['Tables']['business_settings']['Row'];

/** Hard-coded fallbacks used until the singleton row has loaded (or if it is
 *  somehow missing). Mirrors the seed in the business_settings migration so the
 *  public contact surfaces never render blank. */
export const BUSINESS_SETTINGS_FALLBACK: BusinessSettings = {
  id: 1,
  legal_name: 'Smart Home Solutions',
  org_number: '790519-7591',
  vat_number: 'SE790519759101',
  f_skatt_approved: true,
  address_street: 'Porfyrvägen 10',
  address_postcode: '187 34',
  address_city: 'Täby',
  address_country: 'Sverige',
  contact_email: 'sales@smarthomesolutions.se',
  support_email: 'support@smarthomesolutions.se',
  contact_phone: '+46 70 287 08 14',
  website: 'https://smarthomesolutions.se',
  bankgiro_number: null,
  payee_name: 'Smart Home Solutions',
  iban: null,
  bic: null,
  bank_name: null,
  payment_terms_days: 30,
  updated_at: new Date(0).toISOString(),
};

export const BUSINESS_SETTINGS_QUERY_KEY = ['business_settings'] as const;
export const PUBLIC_BUSINESS_SETTINGS_QUERY_KEY = ['business_settings_public'] as const;

/** Fields that never appear in the public view (payment details). */
const PAYMENT_FIELDS = ['bankgiro_number', 'iban', 'bic', 'bank_name'] as const;

/** Business settings minus the payment details that only staff/paying customers see. */
export type PublicBusinessSettings = Omit<BusinessSettings, (typeof PAYMENT_FIELDS)[number]>;

export const PUBLIC_BUSINESS_SETTINGS_FALLBACK: PublicBusinessSettings = (() => {
  const full = { ...BUSINESS_SETTINGS_FALLBACK } as Partial<BusinessSettings>;
  for (const field of PAYMENT_FIELDS) delete full[field];
  return full as PublicBusinessSettings;
})();

async function fetchBusinessSettings(): Promise<BusinessSettings> {
  const { data, error } = await supabase
    .from('business_settings')
    .select('*')
    .eq('id', 1)
    .maybeSingle();
  if (error) throw error;
  return data ?? BUSINESS_SETTINGS_FALLBACK;
}

async function fetchPublicBusinessSettings(): Promise<PublicBusinessSettings> {
  // Reads the business_settings_public view, which excludes payment details and
  // is readable by anon + authenticated (the base table is staff-only).
  const { data, error } = await supabase
    .from('business_settings_public' as never)
    .select('*')
    .eq('id', 1)
    .maybeSingle();
  if (error) throw error;
  return (data as PublicBusinessSettings | null) ?? PUBLIC_BUSINESS_SETTINGS_FALLBACK;
}

/**
 * Full business settings including payment details. The base table is
 * staff-only, so this is for staff surfaces (settings page, accounting).
 * Customer/anon surfaces must use {@link usePublicBusinessSettings} instead.
 */
export function useBusinessSettings() {
  const query = useQuery({
    queryKey: BUSINESS_SETTINGS_QUERY_KEY,
    queryFn: fetchBusinessSettings,
    staleTime: 5 * 60 * 1000,
  });
  return {
    ...query,
    settings: query.data ?? BUSINESS_SETTINGS_FALLBACK,
  };
}

/**
 * Public business settings (no payment details). Safe on the marketing pages,
 * the footer, and anywhere shown to customers or anonymous visitors.
 */
export function usePublicBusinessSettings() {
  const query = useQuery({
    queryKey: PUBLIC_BUSINESS_SETTINGS_QUERY_KEY,
    queryFn: fetchPublicBusinessSettings,
    staleTime: 5 * 60 * 1000,
  });
  return {
    ...query,
    settings: query.data ?? PUBLIC_BUSINESS_SETTINGS_FALLBACK,
  };
}
