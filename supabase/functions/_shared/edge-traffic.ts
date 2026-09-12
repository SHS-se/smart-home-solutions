import { NetworkTraffic } from './network-traffic.ts';

/** One compact report per invocation, with no telemetry database writes. */
export function withTrafficMetrics(
  endpoint: string,
  handler: (request: Request, traffic: NetworkTraffic) => Promise<Response>,
  log: (report: string) => void = console.info,
) {
  return async (request: Request): Promise<Response> => {
    const traffic = new NetworkTraffic();
    let status: number | null = null;
    let responseBytes: number | null = null;
    try {
      const response = await handler(request, traffic);
      status = response.status;
      if (request.method !== 'OPTIONS') {
        try { responseBytes = (await response.clone().arrayBuffer()).byteLength; } catch { /* explicitly unknown */ }
      }
      return response;
    } finally {
      if (request.method !== 'OPTIONS') {
        try {
          log(JSON.stringify({ event: 'shs_network_traffic', endpoint, status,
            response_body_bytes: responseBytes, upstream: traffic.snapshot() }));
        } catch { /* Diagnostics must never turn a successful request into an outage. */ }
      }
    }
  };
}
