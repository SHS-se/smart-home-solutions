import { supabase } from '@/integrations/supabase/client';
import type { ExchangeRateLookupResult } from './accounting-fx';
import type { EcbRateRequest } from './ecb-rate-core';

export async function fetchEcbExchangeRates(requests: EcbRateRequest[]): Promise<ExchangeRateLookupResult[]> {
  if (requests.length === 0) return [];

  const { data, error } = await supabase.functions.invoke('fetch-ecb-exchange-rate', {
    body: {
      requests: requests.map((request) => ({
        currency: request.currency,
        documentDate: request.documentDate,
      })),
    },
  });

  if (error) throw error;
  if (!data?.results || !Array.isArray(data.results)) {
    throw new Error('ECB lookup returned no results');
  }

  return data.results as ExchangeRateLookupResult[];
}

export async function fetchSingleEcbExchangeRate(request: EcbRateRequest): Promise<ExchangeRateLookupResult> {
  const [result] = await fetchEcbExchangeRates([request]);
  if (!result) {
    throw new Error(`No ECB rate returned for ${request.currency} on ${request.documentDate}`);
  }
  return result;
}
