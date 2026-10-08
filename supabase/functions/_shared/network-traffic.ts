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

/** Statuses that carry no body: a Response cannot be constructed with one, even an empty stream. */
const NULL_BODY_STATUS = new Set([101, 103, 204, 205, 304]);

/** Count the caller's stream once; never buffer or clone a planning payload. */
export function measureResponse(
  response: Response,
  finished: (bytes: number, complete: boolean) => void,
): Response {
  // Chromium hands back an empty stream, not null, for a 204: every PostgREST
  // write without a returned row. Wrapping it would throw after the write landed.
  if (!response.body || NULL_BODY_STATUS.has(response.status)) {
    finished(0, true);
    return response;
  }
  const reader = response.body.getReader();
  let bytes = 0;
  let settled = false;
  const finish = (complete: boolean) => {
    if (settled) return;
    settled = true;
    try { finished(bytes, complete); } catch { /* Measurement cannot break delivery. */ }
  };
  return new Response(new ReadableStream<Uint8Array>({
    async pull(controller) {
      try {
        const next = await reader.read();
        if (next.done) {
          finish(true);
          controller.close();
        } else {
          bytes += next.value.byteLength;
          controller.enqueue(next.value);
        }
      } catch (error) {
        finish(false);
        controller.error(error);
      }
    },
    async cancel(reason) {
      finish(false);
      await reader.cancel(reason);
    },
  }, { highWaterMark: 0 }), {
    status: response.status, statusText: response.statusText, headers: response.headers,
  });
}

export class NetworkTraffic {
  private readonly startedAt = new Date().toISOString();
  private readonly started = performance.now();
  private readonly endpoints = new Map<string, TrafficTotals>();

  constructor(
    private readonly fetcher: typeof fetch = globalThis.fetch.bind(globalThis),
    private readonly requestTimeoutMs?: number,
  ) {}

  /** Fetch returns on headers; byte counts settle when the caller reads the body. */
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
      const callerSignal = init?.signal ?? (input instanceof Request ? input.signal : undefined);
      const deadline = this.requestTimeoutMs === undefined ? undefined : AbortSignal.timeout(this.requestTimeoutMs);
      const response = await this.fetcher(input, { ...init,
        signal: deadline && callerSignal ? AbortSignal.any([callerSignal, deadline]) : deadline ?? callerSignal,
      });
      if (response.status >= 400) totals.http_errors++;
      return measureResponse(response, (bytes, complete) => {
        if (complete) {
          totals.response_body_bytes += bytes;
          totals.responses_measured++;
        } else totals.responses_unmeasured++;
        totals.elapsed_ms += performance.now() - started;
      });
    } catch (error) {
      totals.transport_errors++;
      totals.responses_unmeasured++;
      totals.elapsed_ms += performance.now() - started;
      throw error;
    }
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
