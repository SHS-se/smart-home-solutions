import { assertEquals } from "@std/assert";
import { createDeviceLearningProbe } from "./device-learning-probe.ts";
import { syntheticPoolLearningReplay } from "../../../tests/device-learning-cpu.fixture.ts";

Deno.test("full learning probe refuses production, anonymous access and non-pool captures", async () => {
  const request = (secret = "private", body = {}) => new Request("https://probe.test", {
    method: "POST", headers: { authorization: `Bearer ${secret}` }, body: JSON.stringify(body),
  });
  const prod = createDeviceLearningProbe("private", "https://oosxndduqzhvrorgogaw.supabase.co");
  assertEquals((await prod(request())).status, 403);
  const probe = createDeviceLearningProbe("private", "https://vxqpgbzseckgceopitpm.supabase.co");
  assertEquals((await probe(request("wrong"))).status, 401);
  assertEquals((await probe(request())).status, 400);
});

Deno.test("full learning probe is deterministic without replacing the process clock", async () => {
  const now_ms = Date.UTC(2026, 6, 1), originalClock = Date.now;
  const input = syntheticPoolLearningReplay(now_ms);
  const probe = createDeviceLearningProbe("private", "https://vxqpgbzseckgceopitpm.supabase.co");
  const call = async (include_publication = false) => {
    const response = await probe(new Request("https://probe.test", { method: "POST",
      headers: { authorization: "Bearer private" }, body: JSON.stringify({ now_ms, input, include_publication }) }));
    assertEquals(response.status, 200);
    return await response.json();
  };
  const first = await call(), second = await call();
  assertEquals(Date.now, originalClock);
  assertEquals(first.publication_sha256, second.publication_sha256);
  assertEquals(first.table_reads, second.table_reads);
  assertEquals(Object.hasOwn(first, "publication"), false);
  const diagnostic = await call(true);
  assertEquals(diagnostic.publication_sha256, first.publication_sha256);
  assertEquals(diagnostic.publication.p_model.last_attempted_at, new Date(now_ms).toISOString());
});
