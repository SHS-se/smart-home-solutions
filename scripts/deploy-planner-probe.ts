import { PROBE_PROJECT, testProbeServiceKey } from "./planner-probe-auth.ts";

const root = new URL("..", import.meta.url).pathname;
const secret = await testProbeServiceKey();
if (/[\r\n]/.test(secret)) throw new Error("Invalid TEST service credential.");
const directory = await Deno.makeTempDir({ prefix: "shs-planner-probe-" });
try {
  const path = `${directory}/probe.env`;
  await Deno.writeTextFile(path, `PLANNER_PROBE_SECRET=${secret}\n`, {
    mode: 0o600,
  });
  for (
    const args of [
      ["secrets", "set", "--project-ref", PROBE_PROJECT, "--env-file", path],
      [
        "functions",
        "deploy",
        "energy-planner-probe",
        "--project-ref",
        PROBE_PROJECT,
        "--use-api",
        "--yes",
      ],
    ]
  ) {
    const result = await new Deno.Command("supabase", {
      cwd: root,
      args,
      stdout: "piped",
      stderr: "null",
    }).output();
    if (!result.success) {
      throw new Error(
        `TEST probe ${args[0]} operation failed (exit ${result.code}).`,
      );
    }
  }
  console.log(
    `Private nonpublishing planner probe deployed to TEST ${PROBE_PROJECT}.`,
  );
} finally {
  await Deno.remove(directory, { recursive: true });
}
