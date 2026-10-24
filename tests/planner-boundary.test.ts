import { assert, assertEquals, assertRejects } from "@std/assert";
import { diskTree, resolve, specifiers, type SourceTree } from "../scripts/module-graph.ts";
import { PLANNER_DIR, plannerDir, plannerVersion } from "../bench/planner-version.ts";
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

Deno.test("pre-native commits cannot execute a retired planner",async()=>{
  const old=memoryTree(PLANNER_DIR,{"energy-optimisation.ts":"export const old=true;"});
  assertEquals(plannerDir(old),null);
  await assertRejects(()=>plannerVersion(old),Error,"no supported native rules planner artifact");
});
Deno.test("the current native artifact has a stable planner identity",async()=>{
  const first=await plannerVersion(tree);
  assert(first.startsWith("v13-rule-wasm:"));
  assertEquals(await plannerVersion(tree),first);
});

const DEVICE_MODELS = `${PLANNER_DIR}/device-models.ts`;
const BOILER_CONSUMPTION = 'supabase/functions/_shared/boiler-consumption.ts';
/** The referee version and both shared physical consumption models. */
const DEVICE_MODELS_PIN = "27:1d59d2768a32d652";

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
    const models = await Promise.all([DEVICE_MODELS, BOILER_CONSUMPTION].map(async path => {
      const { code } = await transform(tree.read(path)!, { loader: "ts", minifyWhitespace: true, minifySyntax: true, format: "esm" });
      return code;
    }));
    const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(JSON.stringify(models)));
    const hash = [...new Uint8Array(digest)].map(b => b.toString(16).padStart(2, "0")).join("").slice(0, 16);
    assertEquals(`${REFEREE_VERSION}:${hash}`, DEVICE_MODELS_PIN,
      "Device or shared boiler consumption models changed: bump REFEREE_VERSION in src/lib/planner-bench/referee.ts so stored results are judged again, then pin the new pair here.");
  } finally {
    stop();
  }
});
