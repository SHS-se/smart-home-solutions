const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type, x-supabase-client-platform, x-supabase-client-platform-version, x-supabase-client-runtime, x-supabase-client-runtime-version",
};

interface RateRequest {
  currency: string;
  documentDate: string;
}

interface ParsedRateDay {
  date: string;
  rates: Record<string, number>;
}

const HISTORICAL_RATES_URL = "https://www.ecb.europa.eu/stats/eurofxref/eurofxref-hist.xml";

function normalizeCurrency(currency: string): string {
  return currency.trim().toUpperCase();
}

function parseEcbHistoricalRates(xml: string): ParsedRateDay[] {
  const dayRegex = /<Cube\s+time=['"](\d{4}-\d{2}-\d{2})['"]>([\s\S]*?)<\/Cube>/g;
  const rateRegex = /<Cube\s+currency=['"]([A-Z]{3})['"]\s+rate=['"]([\d.]+)['"]\s*\/>/g;
  const days: ParsedRateDay[] = [];

  let dayMatch: RegExpExecArray | null;
  while ((dayMatch = dayRegex.exec(xml)) !== null) {
    const [, date, innerXml] = dayMatch;
    const rates: Record<string, number> = {};
    let rateMatch: RegExpExecArray | null;

    while ((rateMatch = rateRegex.exec(innerXml)) !== null) {
      rates[rateMatch[1]] = Number(rateMatch[2]);
    }

    if (Object.keys(rates).length > 0) {
      days.push({ date, rates });
    }
  }

  return days.sort((left, right) => right.date.localeCompare(left.date));
}

function getSekRateForCurrency(days: ParsedRateDay[], request: RateRequest) {
  const currency = normalizeCurrency(request.currency);
  if (currency === "SEK") {
    return {
      currency,
      rate: 1,
      rateDate: request.documentDate,
      source: "SEK",
    };
  }

  if (!["EUR", "USD"].includes(currency)) {
    throw new Error(`Unsupported currency: ${currency}`);
  }

  for (const day of days) {
    if (day.date > request.documentDate) continue;
    const sekPerEur = day.rates.SEK;
    if (!sekPerEur) continue;

    if (currency === "EUR") {
      return {
        currency,
        rate: sekPerEur,
        rateDate: day.date,
        source: "ECB",
      };
    }

    const currencyPerEur = day.rates[currency];
    if (!currencyPerEur) continue;

    return {
      currency,
      rate: sekPerEur / currencyPerEur,
      rateDate: day.date,
      source: "ECB",
    };
  }

  throw new Error(`No ECB rate found on or before ${request.documentDate} for ${currency}`);
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response(null, { headers: corsHeaders });
  }

  try {
    const body = await req.json();
    const requests = Array.isArray(body?.requests) ? body.requests as RateRequest[] : [];
    if (requests.length === 0) {
      return new Response(JSON.stringify({ error: "No rate requests supplied" }), {
        status: 400,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const response = await fetch(HISTORICAL_RATES_URL);
    if (!response.ok) {
      throw new Error(`ECB lookup failed with ${response.status}`);
    }

    const xml = await response.text();
    const days = parseEcbHistoricalRates(xml);
    if (days.length === 0) {
      throw new Error("ECB response did not contain any daily rates");
    }

    const results = requests.map((request) => {
      const normalizedRequest = {
        currency: normalizeCurrency(request.currency),
        documentDate: request.documentDate,
      };
      const lookup = getSekRateForCurrency(days, normalizedRequest);
      return {
        currency: lookup.currency,
        documentDate: normalizedRequest.documentDate,
        rate: Number(lookup.rate.toFixed(8)),
        rateDate: lookup.rateDate,
        source: lookup.source,
      };
    });

    return new Response(JSON.stringify({ results }), {
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unexpected error";
    return new Response(JSON.stringify({ error: message }), {
      status: 500,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }
});
