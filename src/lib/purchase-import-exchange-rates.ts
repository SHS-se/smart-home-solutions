import type { ExchangeRateLookupResult } from './accounting-fx';
import { normalizeCurrency } from './accounting-fx';
import type { EcbRateRequest } from './ecb-rate-core';

export interface PurchaseImportRateCandidate {
  currency: string;
  documentDate: string;
}

export function buildPurchaseImportRateKey(currency: string, documentDate: string): string {
  return `${normalizeCurrency(currency)}::${documentDate}`;
}

export function collectUniquePurchaseImportRateRequests(
  candidates: PurchaseImportRateCandidate[],
): EcbRateRequest[] {
  const uniqueRequests = new Map<string, EcbRateRequest>();

  for (const candidate of candidates) {
    const currency = normalizeCurrency(candidate.currency);
    const documentDate = candidate.documentDate.trim();
    if (currency === 'SEK' || !documentDate) continue;

    const key = buildPurchaseImportRateKey(currency, documentDate);
    if (!uniqueRequests.has(key)) {
      uniqueRequests.set(key, { currency, documentDate });
    }
  }

  return [...uniqueRequests.values()];
}

export function buildPurchaseImportRateLookupMap(
  requests: EcbRateRequest[],
  results: ExchangeRateLookupResult[],
): Map<string, ExchangeRateLookupResult> {
  if (requests.length !== results.length) {
    throw new Error('ECB lookup returned an unexpected number of results');
  }

  return new Map(
    requests.map((request, index) => [
      buildPurchaseImportRateKey(request.currency, request.documentDate),
      results[index],
    ]),
  );
}
