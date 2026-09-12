/** Payload counters, not a billing meter. Never retain URLs, queries or bodies. */
export interface TrafficTotals {
  requests: number;
  http_errors: number;
  transport_errors: number;
  response_body_bytes: number;
  responses_measured: number;
  responses_unmeasured: number;
  request_body_bytes_estimate: number;
  request_bodies_unmeasured: number;
  elapsed_ms: number;
}

function empty(): TrafficTotals {
  return { requests: 0, http_errors: 0, transport_errors: 0,
    response_body_bytes: 0, responses_measured: 0, responses_unmeasured: 0,
    request_body_bytes_estimate: 0, request_bodies_unmeasured: 0, elapsed_ms: 0 };
}

/** Only fixed API resource names; object keys, IDs and query values are omitted. */
export function trafficEndpoint(input: RequestInfo | URL, method?: string): string {
  const verb = (method ?? (input instanceof Request ? input.method : 'GET')).toUpperCase();
  const safeVerb = /^(GET|POST|PUT|PATCH|DELETE|HEAD|OPTIONS)$/.test(verb) ? verb : 'OTHER';
  try {
    const path = new URL(input instanceof Request ? input.url : String(input)).pathname;
    const resource = path.match(/^\/(rest\/v1\/(?:rpc\/)?|functions\/v1\/)([a-z][a-z_\-]{0,79})\/?$/);
    const category = path.startsWith('/auth/v1/') ? '/auth/v1/*'
      : path.startsWith('/storage/v1/') ? '/storage/v1/*' : '/other';
    return `${safeVerb} ${resource ? '/' + resource[1] + resource[2] : category}`;
  } catch { return `${safeVerb} /other`; }
}

export class NetworkTraffic {
  private readonly startedAt = new Date().toISOString();
  private readonly started = performance.now();
  private readonly endpoints = new Map<string, TrafficTotals>();

  constructor(private readonly fetcher: typeof fetch = globalThis.fetch.bind(globalThis)) {}

  /** Clone consumption counts decoded body bytes and leaves the caller's response intact. */
  fetch: typeof fetch = async (input, init) => {
    const endpoint = trafficEndpoint(input, init?.method);
    const key = this.endpoints.has(endpoint) || this.endpoints.size < 64 ? endpoint : 'OTHER /overflow';
    let totals = this.endpoints.get(key);
    if (!totals) { totals = empty(); this.endpoints.set(key, totals); }
    totals.requests++;
    const body = init?.body;
    if (typeof body === 'string') totals.request_body_bytes_estimate += new TextEncoder().encode(body).byteLength;
    else if (body instanceof ArrayBuffer) totals.request_body_bytes_estimate += body.byteLength;
    else if (ArrayBuffer.isView(body)) totals.request_body_bytes_estimate += body.byteLength;
    else if (body != null || (input instanceof Request && input.body !== null)) totals.request_bodies_unmeasured++;
    const started = performance.now();
    try {
      const response = await this.fetcher(input, init);
      if (response.status >= 400) totals.http_errors++;
      try {
        const bytes = (await response.clone().arrayBuffer()).byteLength;
        totals.response_body_bytes += bytes;
        totals.responses_measured++;
      } catch { totals.responses_unmeasured++; }
      return response;
    } catch (error) {
      totals.transport_errors++;
      totals.responses_unmeasured++;
      throw error;
    } finally { totals.elapsed_ms += performance.now() - started; }
  };

  snapshot() {
    const endpoints = Object.fromEntries([...this.endpoints].map(([key, value]) => [key, { ...value }]));
    const total = empty();
    for (const value of Object.values(endpoints)) {
      for (const key of Object.keys(total) as (keyof TrafficTotals)[]) total[key] += value[key];
    }
    return { schema_version: 1, started_at: this.startedAt,
      observed_seconds: (performance.now() - this.started) / 1000,
      byte_basis: 'decoded_response_body; request_body_estimate; excludes_headers_and_transport',
      total, endpoints };
  }
}
