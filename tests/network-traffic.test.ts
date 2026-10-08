import { assertEquals, assertRejects, assert } from 'jsr:@std/assert@1';
import { measureResponse, NetworkTraffic, trafficEndpoint } from '../supabase/functions/_shared/network-traffic.ts';
import { withTrafficMetrics } from '../supabase/functions/_shared/edge-traffic.ts';
import { browserTrafficReport, recordPortalSync } from '../src/lib/network-traffic.ts';

Deno.test('traffic counts UTF-8 bytes and HTTP errors without consuming the response', async () => {
  let calls = 0;
  const payload = JSON.stringify({ error: 'å☀' });
  const meter = new NetworkTraffic(async (_input, init) => {
    calls++;
    assertEquals(new Headers(init?.headers).get('Authorization'), 'Bearer secret');
    return new Response(payload, { status: 503, headers: { 'x-test': 'preserved', 'content-length': '3' } });
  });
  const response = await meter.fetch('https://db.example/rest/v1/rpc/get_energy_portal_delta?customer_id=secret', {
    method: 'POST', body: payload, headers: { Authorization: 'Bearer secret' },
  });
  assertEquals(await response.text(), payload);
  assertEquals(response.status, 503);
  assertEquals(response.headers.get('x-test'), 'preserved');
  const report = meter.snapshot();
  assertEquals(calls, 1);
  assertEquals(report.total.response_body_bytes, new TextEncoder().encode(payload).length);
  assertEquals(report.total.request_body_bytes_estimate, new TextEncoder().encode(payload).length);
  assertEquals(report.total.http_errors, 1);
  assertEquals(report.total.responses_measured, 1);
  assert(!JSON.stringify(report).includes('secret'));
  assertEquals(Object.keys(report.endpoints), ['POST /rest/v1/rpc/get_energy_portal_delta']);
  report.total.requests = 99;
  Object.values(report.endpoints)[0].requests = 99;
  assertEquals(meter.snapshot().total.requests, 1);
});

Deno.test('traffic preserves transport failures and marks unmeasured responses explicitly', async () => {
  const failure = new TypeError('offline');
  const meter = new NetworkTraffic(async () => { throw failure; });
  const caught = await assertRejects(() => meter.fetch('https://db.example/rest/v1/customers'), TypeError);
  assertEquals(caught, failure);
  assertEquals(meter.snapshot().total.transport_errors, 1);
  assertEquals(meter.snapshot().total.responses_unmeasured, 1);
  assertEquals(meter.snapshot().total.responses_measured, 0);
});

Deno.test('traffic measures no-content responses and unknown request bodies correctly', async () => {
  const meter = new NetworkTraffic(async () => new Response(null, { status: 204 }));
  const req = new Request('https://db.example/rest/v1/customers', { method: 'POST', body: 'opaque' });
  assertEquals((await meter.fetch(req)).status, 204);
  assertEquals(meter.snapshot().total.response_body_bytes, 0);
  assertEquals(meter.snapshot().total.responses_measured, 1);
  assertEquals(meter.snapshot().total.request_bodies_unmeasured, 1);
});

Deno.test('a no-content response with an empty stream for a body, as Chromium gives, is returned as it is', async () => {
  const original = new Response(null, { status: 204 });
  Object.defineProperty(original, 'body', { value: new ReadableStream({ start(controller) { controller.close(); } }) });
  const meter = new NetworkTraffic(async () => original);
  const response = await meter.fetch('https://db.example/rest/v1/bench_scenarios', { method: 'PATCH', body: '{}' });
  assertEquals(response, original);
  assertEquals(meter.snapshot().total.responses_measured, 1);
  assertEquals(meter.snapshot().total.response_body_bytes, 0);
});

Deno.test('measurement failure does not replace the original response or pretend zero bytes were measured', async () => {
  const meter = new NetworkTraffic(async () => new Response(new ReadableStream({
    start(controller) { controller.error(new Error('interrupted body')); },
  })));
  const response = await meter.fetch('https://db.example/rest/v1/customers');
  await assertRejects(() => response.text(), Error, 'interrupted body');
  assertEquals(meter.snapshot().total.responses_unmeasured, 1);
  assertEquals(meter.snapshot().total.responses_measured, 0);
});

Deno.test('endpoint cardinality is bounded and dynamic paths are redacted', async () => {
  assertEquals(trafficEndpoint('https://secret:password@db.example/storage/v1/object/private/customer/address'), 'GET /storage/v1/*');
  assertEquals(trafficEndpoint('https://db.example/auth/v1/user/secret'), 'GET /auth/v1/*');
  assertEquals(trafficEndpoint('https://db.example/rest/v1/customers/secret'), 'GET /other');
  const meter = new NetworkTraffic(async () => new Response('x'));
  await Promise.all(Array.from({ length: 80 }, (_, i) => meter.fetch(`https://db.example/rest/v1/table_${'a'.repeat(i + 1)}`).then(response => response.text())));
  assert(Object.keys(meter.snapshot().endpoints).length <= 65);
  assertEquals(meter.snapshot().total.requests, 80);
  assertEquals(meter.snapshot().total.response_body_bytes, 80);
});

Deno.test('edge reports separate outgoing bytes, skip preflight and isolate logging failures', async () => {
  const logs: string[] = [];
  const handler = withTrafficMetrics('integration-status', async () => new Response('å'), (report) => logs.push(report));
  assertEquals(await (await handler(new Request('https://edge.example?token=secret'))).text(), 'å');
  const report = JSON.parse(logs[0]);
  assertEquals(report.response_body_bytes, 2);
  assertEquals(report.upstream.total.requests, 0);
  assertEquals(report.status, 200);
  assert(!logs[0].includes('secret'));
  await (await handler(new Request('https://edge.example', { method: 'OPTIONS' }))).text();
  assertEquals(logs.length, 1);
  const brokenLog = withTrafficMetrics('test', async () => new Response('ok'), () => { throw new Error('log unavailable'); });
  assertEquals(await (await brokenLog(new Request('https://edge.example'))).text(), 'ok');
});

Deno.test('edge reports upstream reads and handler failures', async () => {
  const logs: string[] = [];
  const handler = withTrafficMetrics('test', async (_request, traffic) => {
    await (await traffic.fetch('data:application/json,%7B%7D')).json();
    throw new Error('handler failed');
  }, (report) => logs.push(report));
  await assertRejects(() => handler(new Request('https://edge.example')), Error, 'handler failed');
  const report = JSON.parse(logs[0]);
  assertEquals(report.status, null);
  assertEquals(report.response_body_bytes, null);
  assertEquals(report.upstream.total.response_body_bytes, 2);
});

Deno.test('portal counters distinguish unchanged polling from plan and history downloads', () => {
  const baseline = browserTrafficReport().portal_sync;
  const delta = { plan: null, devices: { value: null }, thermal: { value: null }, zone_models: { value: null },
    actuals: { upserts: [], removed: [] }, prices: { upserts: [], removed: [] }, device_actuals: { upserts: [], removed: [] } };
  recordPortalSync(delta, false);
  recordPortalSync({ ...delta, plan: {}, devices: { value: [] }, actuals: { upserts: [{}], removed: ['old'] } }, true);
  const report = browserTrafficReport().portal_sync;
  assertEquals(report.unchanged_payloads - baseline.unchanged_payloads, 1);
  assertEquals(report.initial_loads - baseline.initial_loads, 1);
  assertEquals(report.plan_downloads - baseline.plan_downloads, 1);
  assertEquals(report.configuration_downloads - baseline.configuration_downloads, 1);
  assertEquals(report.history_upserts - baseline.history_upserts, 1);
  assertEquals(report.history_removals - baseline.history_removals, 1);
});

Deno.test('traffic returns headers without waiting for a stalled body and forwards cancellation', async () => {
  let cancelled = false;
  let observedSignal: AbortSignal | null | undefined;
  const caller = new AbortController();
  const meter = new NetworkTraffic(async (_input, init) => {
    observedSignal = init?.signal;
    return new Response(new ReadableStream({ cancel() { cancelled = true; } }));
  });
  const response = await meter.fetch('https://db.example/rest/v1/plan', { signal: caller.signal });
  assert(observedSignal);
  assertEquals(observedSignal.aborted, false);
  caller.abort();
  assertEquals(observedSignal.aborted, true);
  await response.body!.cancel();
  assertEquals(cancelled, true);
  assertEquals(meter.snapshot().total.responses_unmeasured, 1);
});

Deno.test('stream measurement forwards the first chunk before the last chunk exists', async () => {
  let source: ReadableStreamDefaultController<Uint8Array>;
  const reports: unknown[] = [];
  const original = new Response(new ReadableStream<Uint8Array>({ start(controller) { source = controller; } }));
  const response = measureResponse(original, (bytes, complete) => reports.push({ bytes, complete }));
  const reader = response.body!.getReader();
  source!.enqueue(new Uint8Array([1, 2, 3]));
  assertEquals((await reader.read()).value, new Uint8Array([1, 2, 3]));
  assertEquals(reports, []);
  source!.enqueue(new Uint8Array([4]));
  source!.close();
  assertEquals((await reader.read()).value, new Uint8Array([4]));
  assertEquals((await reader.read()).done, true);
  assertEquals(reports, [{ bytes: 4, complete: true }]);
});

Deno.test('upstream deadline remains active while consuming a stalled response body', async () => {
  const meter = new NetworkTraffic(async (_input, init) => new Response(new ReadableStream({
    start(controller) {
      const signal = init!.signal!;
      signal.addEventListener('abort', () => controller.error(signal.reason), { once: true });
    },
  })), 5);
  const response = await meter.fetch('https://db.example/rest/v1/plan');
  await assertRejects(() => response.text(), DOMException);
  assertEquals(meter.snapshot().total.responses_unmeasured, 1);
});
