import { measureResponse, NetworkTraffic } from './network-traffic.ts';

/** One compact report per invocation, with no telemetry database writes. */
export function withTrafficMetrics(
  endpoint: string,
  handler: (request: Request, traffic: NetworkTraffic) => Promise<Response>,
  log: (report: string) => void = console.info,
) {
  return async (request: Request): Promise<Response> => {
    const traffic = new NetworkTraffic(globalThis.fetch.bind(globalThis), 30_000);
    let status: number | null = null;
    const report = (responseBytes: number | null) => {
      if (request.method === 'OPTIONS') return;
      try {
        log(JSON.stringify({ event: 'shs_network_traffic', endpoint, status,
          response_body_bytes: responseBytes, upstream: traffic.snapshot() }));
      } catch { /* Diagnostics must never turn a successful request into an outage. */ }
    };
    try {
      const response = await handler(request, traffic);
      status = response.status;
      return request.method === 'OPTIONS' ? response : measureResponse(response,
        (bytes, complete) => report(complete ? bytes : null));
    } catch (error) {
      report(null);
      throw error;
    }
  };
}
