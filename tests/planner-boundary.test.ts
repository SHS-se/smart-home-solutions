import { assert, assertEquals, assertNotEquals } from "@std/assert";
import { diskTree, resolve, specifiers, type SourceTree } from "../scripts/module-graph.ts";
import { PLANNER_DIR, plannerVersion } from "../bench/planner-version.ts";

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
