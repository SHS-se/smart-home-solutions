// Rebuild from another checkout path to catch Cargo's path-dependent symbol
// identities. The tracked artifact must match exactly, with no normalization.
import { createHash } from "node:crypto";
import { dirname } from "node:path";
import { plannerSourceFiles } from "./build-planner-wasm.ts";

const root = new URL("..", import.meta.url).pathname;
const temporary = await Deno.makeTempDir({
  prefix: "planner-build-reproduction-",
});
const artifact = "supabase/functions/_shared/planner-wasm/solver.wasm";
const digest = (bytes: Uint8Array) =>
  createHash("sha256").update(bytes).digest("hex");
try {
  for (const file of plannerSourceFiles(root)) {
    await Deno.mkdir(dirname(`${temporary}/${file}`), { recursive: true });
    await Deno.copyFile(`${root}/${file}`, `${temporary}/${file}`);
  }
  await Deno.mkdir(`${temporary}/supabase/functions/energy-planner-probe`, {
    recursive: true,
  });
  await Deno.mkdir(`${root}/planner-core/target/reproducibility`, {
    recursive: true,
  });
  await Deno.symlink(
    `${root}/planner-core/target/reproducibility`,
    `${temporary}/planner-core/target`,
  );
  const result = await new Deno.Command(Deno.execPath(), {
    args: [
      "run",
      "--no-config",
      "--allow-read",
      "--allow-write",
      "--allow-run",
      "--allow-env=HOME,CARGO_HOME",
      `${temporary}/scripts/build-planner-wasm.ts`,
    ],
    stdout: "piped",
    stderr: "piped",
  }).output();
  if (!result.success) {
    throw new Error(new TextDecoder().decode(result.stderr));
  }
  const expected = digest(await Deno.readFile(`${root}/${artifact}`));
  const actual = digest(await Deno.readFile(`${temporary}/${artifact}`));
  if (actual !== expected) {
    throw new Error(`Wasm depends on checkout path: ${expected} != ${actual}`);
  }
  const manifest = "supabase/functions/_shared/planner-wasm/artifact.json";
  if (
    await Deno.readTextFile(`${root}/${manifest}`) !==
      await Deno.readTextFile(`${temporary}/${manifest}`)
  ) {
    throw new Error("Planner source manifest depends on checkout path.");
  }
  console.log(
    `Independent checkout reproduces the exact Wasm and source manifest: ${actual}`,
  );
} finally {
  await Deno.remove(temporary, { recursive: true });
}
