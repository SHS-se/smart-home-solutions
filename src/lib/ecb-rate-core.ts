import type { ExchangeRateLookupResult } from './accounting-fx';

export interface EcbRateRequest {
  currency: string;
  documentDate: string;
}

interface EcbRateDay {
  date: string;
  sekPerEur: number;
  usdPerEur: number | null;
}

export const ECB_HISTORICAL_RATES_URL = 'https://www.ecb.europa.eu/stats/eurofxref/eurofxref-hist.xml';

export function normalizeEcbCurrency(currency: string): string {
  return currency.trim().toUpperCase();
}

export function parseEcbHistoricalRates(xml: string): EcbRateDay[] {
  const dayRegex = /<Cube\s+time=['"](\d{4}-\d{2}-\d{2})['"]>([\s\S]*?)<\/Cube>/g;
  const sekRegex = /<Cube\s+currency=['"]SEK['"]\s+rate=['"]([\d.]+)['"]\s*\/>/;
  const usdRegex = /<Cube\s+currency=['"]USD['"]\s+rate=['"]([\d.]+)['"]\s*\/>/;
  const days: EcbRateDay[] = [];

  let match: RegExpExecArray | null;
  while ((match = dayRegex.exec(xml)) !== null) {
    const [, date, body] = match;
    const sekMatch = body.match(sekRegex);
    if (!sekMatch) continue;
    const usdMatch = body.match(usdRegex);

    days.push({
      date,
      sekPerEur: Number(sekMatch[1]),
      usdPerEur: usdMatch ? Number(usdMatch[1]) : null,
    });
  }

  return days.sort((left, right) => right.date.localeCompare(left.date));
}

export function resolveEcbExchangeRate(
  request: EcbRateRequest,
  days: EcbRateDay[],
): ExchangeRateLookupResult {
  const currency = normalizeEcbCurrency(request.currency);

  if (currency === 'SEK') {
    return {
      currency,
      rate: 1,
      rateDate: request.documentDate,
      source: 'SEK',
    };
  }

  if (!['EUR', 'USD'].includes(currency)) {
    throw new Error(`Unsupported currency: ${currency}`);
  }

  const day = days.find((candidate) => candidate.date <= request.documentDate && (currency !== 'USD' || candidate.usdPerEur != null));
  if (!day) {
    throw new Error(`No ECB rate found on or before ${request.documentDate} for ${currency}`);
  }

  const rate = currency === 'EUR'
    ? day.sekPerEur
    : day.usdPerEur
      ? day.sekPerEur / day.usdPerEur
      : null;

  if (!rate) {
    throw new Error(`No usable ECB ${currency} rate found on or before ${request.documentDate}`);
  }

  return {
    currency,
    rate: Number(rate.toFixed(8)),
    rateDate: day.date,
    source: 'ECB',
  };
}

export async function fetchEcbExchangeRatesDirect(
  requests: EcbRateRequest[],
  fetchImpl: typeof fetch = fetch,
): Promise<ExchangeRateLookupResult[]> {
  if (requests.length === 0) return [];

  const response = await fetchImpl(ECB_HISTORICAL_RATES_URL);
  if (!response.ok) {
    throw new Error(`ECB lookup failed with status ${response.status}`);
  }

  const xml = await response.text();
  const days = parseEcbHistoricalRates(xml);
  if (days.length === 0) {
    throw new Error('ECB historical rate file did not contain any SEK rates');
  }

  return requests.map((request) => resolveEcbExchangeRate(request, days));
}

