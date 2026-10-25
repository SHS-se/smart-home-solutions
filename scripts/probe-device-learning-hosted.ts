/** Full cold-worker qualification on TEST, with no database writes or devices. */
import { assertEquals } from "@std/assert";
import { compareLearningPublications } from "../supabase/functions/_shared/device-learning-publication.ts";
import { syntheticPoolLearningReplay } from "../tests/device-learning-cpu.fixture.ts";
import { createDeviceLearningProbe } from "../supabase/functions/_shared/device-learning-probe.ts";
import { PROBE_PROJECT, testProbeServiceKey } from "./planner-probe-auth.ts";

const secret = await testProbeServiceKey();
const now_ms = Date.UTC(2026, 6, 1);
const input = syntheticPoolLearningReplay(now_ms);
const payload = JSON.stringify({ now_ms, input, include_publication: true });
const headers = { authorization: `Bearer ${secret}`, "content-type": "application/json" };
const url = `https://${PROBE_PROJECT}.supabase.co/functions/v1/energy-device-learning-probe`;
const local = await createDeviceLearningProbe(secret, `https://${PROBE_PROJECT}.supabase.co`)(
  new Request(url, { method: "POST", headers, body: payload }));
assertEquals(local.status, 200);
const expected = await local.json();
const repeatedLocal = await (await createDeviceLearningProbe(secret, `https://${PROBE_PROJECT}.supabase.co`)(
  new Request(url, { method: "POST", headers, body: payload }))).json();
assertEquals(repeatedLocal.publication_sha256, expected.publication_sha256, "Same-runtime learning publication must be bitwise deterministic");
let hostedHash: string | undefined;
for (let repeat = 0; repeat < 3; repeat++) {
  const response = await fetch(url, { method: "POST", headers, body: payload, signal: AbortSignal.timeout(8000) });
  const result = await response.json();
  assertEquals(response.status, 200, `Full TEST learning worker failed: HTTP ${response.status}, ${JSON.stringify(result)}`);
  assertEquals(result.qualification, "test_learning_candidate");
  const diagnostics = compareLearningPublications(expected.publication, result.publication);
  if (hostedHash !== undefined) assertEquals(result.publication_sha256, hostedHash, "Repeated hosted publication must be bitwise deterministic");
  hostedHash = result.publication_sha256;
  assertEquals(result.table_reads, expected.table_reads);
  console.log(JSON.stringify({ repeat, project: PROBE_PROJECT, handler_elapsed_ms: result.handler_elapsed_ms,
    table_reads: result.table_reads, publication_bytes: result.publication_bytes, parity: "exact_selected_model", diagnostic_ulp_differences: diagnostics }));
}
