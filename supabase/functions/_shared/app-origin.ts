function normalizeOrigin(value: string, source: string): string {
  let parsed: URL;

  try {
    parsed = new URL(value);
  } catch {
    throw new Error(`FATAL: ${source} is not a valid absolute URL: ${value}`);
  }

  if (!parsed.protocol || !parsed.host) {
    throw new Error(`FATAL: ${source} is missing protocol or host: ${value}`);
  }

  return parsed.origin;
}

function getAllowedAppOrigins(): Set<string> {
  const rawAllowlist = Deno.env.get("APP_ORIGIN_ALLOWLIST");
  if (!rawAllowlist) {
    throw new Error("FATAL: APP_ORIGIN_ALLOWLIST is not set. Deployment is misconfigured.");
  }

  const origins = rawAllowlist
    .split(/[,\n]/)
    .map((entry) => entry.trim())
    .filter(Boolean)
    .map((entry) => normalizeOrigin(entry, "APP_ORIGIN_ALLOWLIST"));

  if (origins.length === 0) {
    throw new Error("FATAL: APP_ORIGIN_ALLOWLIST is empty. Deployment is misconfigured.");
  }

  return new Set(origins);
}

function extractCandidateOrigins(req: Request): string[] {
  const candidates: string[] = [];
  const originHeader = req.headers.get("origin");
  if (originHeader) {
    candidates.push(normalizeOrigin(originHeader, "Origin header"));
  }

  const refererHeader = req.headers.get("referer");
  if (refererHeader) {
    candidates.push(normalizeOrigin(refererHeader, "Referer header"));
  }

  return [...new Set(candidates)];
}

export function getRequestAppOrigin(req: Request): string {
  const allowedOrigins = getAllowedAppOrigins();
  const candidateOrigins = extractCandidateOrigins(req);

  if (candidateOrigins.length === 0) {
    throw new Error(
      "FATAL: Could not determine app origin from request. Expected Origin or Referer header."
    );
  }

  for (const origin of candidateOrigins) {
    if (allowedOrigins.has(origin)) {
      return origin;
    }
  }

  throw new Error(
    `FATAL: Request origin is not allowed: ${candidateOrigins.join(", ")}. ` +
      `Allowed origins: ${Array.from(allowedOrigins).join(", ")}`
  );
}

/**
 * Primary app origin for contexts with no inbound request (Stripe webhooks,
 * crons): the first entry in APP_ORIGIN_ALLOWLIST, i.e. the canonical app URL
 * for the current environment. Use only when there is no Request to derive from.
 */
export function getPrimaryAppOrigin(): string {
  return [...getAllowedAppOrigins()][0];
}

export function tryGetRequestAppOrigin(req: Request): string | null {
  try {
    return getRequestAppOrigin(req);
  } catch (error) {
    console.warn(
      "app-origin: could not resolve request origin:",
      error instanceof Error ? error.message : String(error)
    );
    return null;
  }
}
