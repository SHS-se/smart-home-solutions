import { assertEquals, assert } from "@std/assert";
import { diskTree, reach, resolve, specifiers } from "../scripts/module-graph.ts";

const root = new URL("..", import.meta.url).pathname;
const tree = diskTree(root);
const shared = "supabase/functions/_shared/";
const learning = `${shared}device-learning/`;
function files(path: string): string[] {
  return [...Deno.readDirSync(root + path)].flatMap(e => e.isDirectory ? files(path + e.name + "/") : [path + e.name]);
}

Deno.test("production planning and captured state cannot reach device learning", () => {
  const graph = reach(tree, [shared + "rules-planner.ts", shared + "pool-capture.ts", shared + "room-planning-zones.ts"]);
  assertEquals([...graph].filter(p => p.startsWith(learning)), []);
  // Negative control: an accidental import through an intermediate module is detected.
  const infected = { ...tree, read: (p: string) => tree.read(p) + (p === shared + "rules-room-services.ts"
    ? '\nimport "./device-learning/room/fit.ts";' : "") };
  assert([...reach(infected, [shared + "rules-planner.ts"])].some(p => p.startsWith(learning)));
});

Deno.test("each device learner sees only its own learning, numerical algebra and pure models", () => {
  const pure = new Set(["models/room/thermal.ts", "device-models.ts", "pool-response.ts", "battery-conversion.ts"]
    .map(p => `${shared}planner/${p}`));
  for (const family of ["room", "pool"]) {
    const entries = files(`${learning}${family}/`).filter(p => p.endsWith(".ts") && !p.endsWith(".test.ts"));
    for (const p of reach(tree, entries)) {
      assert(p.startsWith(`${learning}${family}/`) || p === `${learning}linear-algebra.ts` ||
        pure.has(p), `Learning ${family} leaked into ${p}`);
    }
  }
});

Deno.test("pure TS physics has no runtime import of learning, search, persistence or UI", () => {
  const entries = files(`${shared}planner/models/`).filter(p => p.endsWith(".ts"));
  const physicalDependencies = new Set(["pool-devices.ts", "device-power-allocation.ts", "device-models.ts", "pool-response.ts", "battery-conversion.ts"]
    .map(p => `${shared}planner/${p}`));
  const violations = (source: typeof tree) => [...reach(source, entries)].flatMap(p => [
    ...(!entries.includes(p) && !physicalDependencies.has(p) ? [p] : []),
    ...specifiers(source.read(p) ?? "").filter(spec => !resolve(source, p, spec)).map(spec => `${p} imports ${spec}`),
  ]);
  assertEquals(violations(tree), []);
  // A permitted physical helper must not smuggle in policy or fitting transitively.
  for (const dependency of ["./value-curves.ts", "../device-learning/pool/thermal.ts", "npm:synthetic-database-client"]) {
    const infected = { ...tree, read: (p: string) => tree.read(p) + (p === `${shared}planner/device-models.ts`
      ? `\nimport "${dependency}";` : "") };
    assert(violations(infected).length > 0, dependency);
  }
});

Deno.test("native model crate cannot depend on solver policy or database libraries", () => {
  const cargo = Deno.readTextFileSync(root + "planner-core/models/Cargo.toml");
  assertEquals(cargo.match(/^\w[\w.-]*\s*=/gm)?.filter(line => !/^(name|version|edition|license|serde(?:\.workspace)?|serde_json)\s*=/.test(line)), []);
  for (const p of files("planner-core/models/src/").filter(p => p.endsWith(".rs"))) {
    assert(!/use\s+(?:shs_planner_core|crate::policy)|import_price|export_price|score_sek/.test(tree.read(p)!), p);
  }
});

Deno.test("EV departure concepts remain absent from executable planner and transport contracts", () => {
  const entries = [shared + "rules-planner.ts", shared + "ha-api-contract.ts"];
  const sourceFiles = [...reach(tree, entries), ...files("planner-core/models/src/").concat(files("planner-core/solver/src/")).filter(p => p.endsWith(".rs"))];
  for (const p of sourceFiles) {
    if (!/\.(ts|rs)$/.test(p) || p.endsWith("solver-bytes.ts")) continue;
    assert(!/\b(?:departure|depart_at|departure_target_soc)\b/i.test(tree.read(p)!), `Forbidden EV departure concept in ${p}`);
  }
});

Deno.test("ingest and model capture cannot reach fitting or planning kernels", () => {
  const entries = ["supabase/functions/energy-optimisation-ingest/index.ts", shared + "room-model-capture.ts",
    shared + "device-model-store.ts", shared + "rules-planning-capture.ts"];
  const forbidden = (path: string) => path.startsWith(learning) || path.startsWith(shared + "device-model-learning/") ||
    /(?:rules-planner\.ts|rules-room-services\.ts|room-heating-schedule\.ts|planner-wasm\/(?:runtime|core|solver-bytes)\.ts)$/.test(path);
  assertEquals([...reach(tree, entries)].filter(forbidden), []);
  for (const accidental of ["./device-learning/room/fit.ts", "./rules-planner.ts"]) {
    const infected = { ...tree, read: (p: string) => tree.read(p) + (p === shared + "room-model-capture.ts"
      ? `\nimport "${accidental}";` : "") };
    assert([...reach(infected, entries)].some(forbidden));
  }
});
