import { assert, assertEquals, assertNotEquals } from "@std/assert";
import { diskTree, resolve, specifiers, type SourceTree } from "../scripts/module-graph.ts";
import { PLANNER_DIR, plannerVersion } from "../bench/planner-version.ts";
import { REFEREE_VERSION } from "../src/lib/planner-bench/referee.ts";

const root = new URL("..", import.meta.url).pathname;
const tree = diskTree(root);
/** Packages the planner may use; anything else would tie it to one runtime. */
const PACKAGES = new Set(["zod"]);

Deno.test("the planner imports nothing from outside its folder, types included", () => {
  const leaks: string[] = [];
  for (const entry of Deno.readDirSync(`${root}/${PLANNER_DIR}`)) {
    if (!entry.isFile || !entry.name.endsWith(".ts") || /\.(test|fixture)\.ts$/.test(entry.name)) continue;
    const file = `${PLANNER_DIR}/${entry.name}`;
    for (const specifier of specifiers(tree.read(file)!, { types: true })) {
      const local = resolve(tree, file, specifier);
      const inside = local ? local.startsWith(`${PLANNER_DIR}/`) : PACKAGES.has(specifier);
      if (!inside) leaks.push(`${file} imports ${specifier}`);
    }
  }
  assertEquals(leaks, []);
});

/** A tree of in-memory files, the planner at `dir`. */
function memoryTree(dir: string, files: Record<string, string>): SourceTree {
  const all = new Map(Object.entries(files).map(([name, text]) => [`${dir}/${name}`, text]));
  return { read: path => all.get(path) ?? null, isFile: path => all.has(path) };
}

const PLANNER = {
  "energy-optimisation.ts": `import { plan } from "./dispatch-plan.ts";\nexport const run = (x: number) => plan(x) + 1;\n`,
  "dispatch-plan.ts": `export function plan(x: number): number {\n  return x * 2;\n}\n`,
};

Deno.test("comments, types, formatting and the folder do not change the planner version", async () => {
  const base = await plannerVersion(memoryTree(PLANNER_DIR, PLANNER));
  const annotated = await plannerVersion(memoryTree(PLANNER_DIR, {
    ...PLANNER,
    "energy-optimisation.ts": `// Plans.\nimport type { Unused } from "../elsewhere.ts";\nimport { plan } from "./dispatch-plan.ts";\n\n/** Runs. */\nexport const run = (x: number): number => plan(x) + 1;\nexport interface Unused { a: string }\n`,
  }));
  // Before the planner had a folder it lived in _shared.
  const legacy = await plannerVersion(memoryTree("supabase/functions/_shared", PLANNER));
  assertEquals(annotated, base);
  assertEquals(legacy, base);
});

Deno.test("a code change is a new planner version", async () => {
  const base = await plannerVersion(memoryTree(PLANNER_DIR, PLANNER));
  const changed = await plannerVersion(memoryTree(PLANNER_DIR, { ...PLANNER, "dispatch-plan.ts": `export function plan(x: number): number {\n  return x * 3;\n}\n` }));
  assertNotEquals(changed, base);
  assert(changed.startsWith("v2-esbuild"));
});

const DEVICE_MODELS = `${PLANNER_DIR}/device-models.ts`;
/** The referee version and the device models' code it judges with. */
const DEVICE_MODELS_PIN = "11:9eeb79c59e7ba576";

Deno.test("the bench judges with one planner file, the device models, and that file stands alone", () => {
  assertEquals(specifiers(tree.read(DEVICE_MODELS)!, { types: true }), []);
  const fromPlanner = new Set<string>();
  for (const entry of Deno.readDirSync(`${root}/src/lib/planner-bench`)) {
    if (!entry.isFile || !/\.tsx?$/.test(entry.name) || /\.(test|fixture)\.ts$/.test(entry.name)) continue;
    const file = `src/lib/planner-bench/${entry.name}`;
    for (const specifier of specifiers(tree.read(file)!, { types: true })) {
      const local = resolve(tree, file, specifier);
      if (local?.startsWith(`${PLANNER_DIR}/`)) fromPlanner.add(local);
    }
  }
  // Every planner version on the bench is judged in this one world, whatever models its own code carries.
  assertEquals([...fromPlanner], [DEVICE_MODELS]);
});

Deno.test("a change to the device models is a change to how every plan is judged", async () => {
  const { transform, stop } = await import("npm:esbuild");
  try {
    const { code } = await transform(tree.read(DEVICE_MODELS)!, { loader: "ts", minifyWhitespace: true, minifySyntax: true, format: "esm" });
    const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(code));
    const hash = [...new Uint8Array(digest)].map(b => b.toString(16).padStart(2, "0")).join("").slice(0, 16);
    assertEquals(`${REFEREE_VERSION}:${hash}`, DEVICE_MODELS_PIN,
      "device-models.ts no longer does what the referee version was pinned to: bump REFEREE_VERSION in src/lib/planner-bench/referee.ts so stored results are judged again, then pin the new pair here.");
  } finally {
    stop();
  }
});
