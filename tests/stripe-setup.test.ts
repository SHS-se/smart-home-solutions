import {
  assertEquals,
  assertStringIncludes,
} from "https://deno.land/std@0.224.0/assert/mod.ts";

const SETUP_SCRIPT = new URL("../scripts/stripe-setup.sh", import.meta.url).pathname;
const TEST_WEBHOOK_URL = "https://vxqpgbzseckgceopitpm.supabase.co/functions/v1/stripe-webhook";
const LIVE_WEBHOOK_URL = "https://oosxndduqzhvrorgogaw.supabase.co/functions/v1/stripe-webhook";

type Mode = "test" | "live";

type SetupResult = {
  code: number;
  stdout: string;
  stderr: string;
  signingSecretFile: string | null;
};

/**
 * Runs the setup script without network access. The fake curl returns a fresh
 * endpoint and signing secret, letting this test cover the script's mode ↔
 * Supabase target ↔ local secret-file mapping end-to-end.
 */
async function runSetup(mode: Mode, extraEnv: Record<string, string> = {}): Promise<SetupResult> {
  const directory = await Deno.makeTempDir({ prefix: "stripe-setup-test-" });
  try {
    const envFile = `${directory}/stripe-key.env`;
    await Deno.writeTextFile(
      envFile,
      `STRIPE_SECRET_KEY=${mode === "test" ? "sk_test_fixture" : "sk_live_fixture"}\n`,
    );

    const fakeCurl = `${directory}/curl`;
    await Deno.writeTextFile(
      fakeCurl,
      `#!/bin/sh
case " $* " in
  *" -G "*) printf '%s\\n' '{"data":[]}' ;;
  *) printf '%s\\n' '{"id":"we_fixture","secret":"whsec_fixture"}' ;;
esac
`,
    );
    await Deno.chmod(fakeCurl, 0o755);

    const output = await new Deno.Command("/bin/bash", {
      args: [SETUP_SCRIPT, "--webhook-only"],
      cwd: directory,
      env: {
        ENV_FILE: envFile,
        PATH: `${directory}:${Deno.env.get("PATH") ?? "/usr/bin:/bin"}`,
        ...(mode === "live" ? { ALLOW_LIVE: "1" } : {}),
        ...extraEnv,
      },
    }).output();

    const secretFileName = mode === "test"
      ? ".env.stripe.webhook.test.local"
      : ".env.stripe.webhook.live.local";
    let signingSecretFile: string | null = null;
    try {
      signingSecretFile = await Deno.readTextFile(`${directory}/${secretFileName}`);
    } catch (error) {
      if (!(error instanceof Deno.errors.NotFound)) throw error;
    }

    return {
      code: output.code,
      stdout: new TextDecoder().decode(output.stdout),
      stderr: new TextDecoder().decode(output.stderr),
      signingSecretFile,
    };
  } finally {
    await Deno.remove(directory, { recursive: true });
  }
}

Deno.test("test Stripe setup is pinned to the test Supabase webhook and secret file", async () => {
  const result = await runSetup("test");

  assertEquals(result.code, 0, result.stderr);
  assertStringIncludes(result.stdout, TEST_WEBHOOK_URL);
  assertEquals(result.signingSecretFile, "STRIPE_WEBHOOK_SECRET=whsec_fixture\n");
});

Deno.test("live Stripe setup is pinned to the production Supabase webhook and secret file", async () => {
  const result = await runSetup("live");

  assertEquals(result.code, 0, result.stderr);
  assertStringIncludes(result.stdout, LIVE_WEBHOOK_URL);
  assertEquals(result.signingSecretFile, "STRIPE_WEBHOOK_SECRET=whsec_fixture\n");
});

Deno.test("Stripe setup refuses a cross-environment webhook target", async () => {
  const testResult = await runSetup("test", { WEBHOOK_URL: LIVE_WEBHOOK_URL });
  assertEquals(testResult.code, 1);
  assertStringIncludes(testResult.stderr, TEST_WEBHOOK_URL);

  const liveResult = await runSetup("live", { WEBHOOK_URL: TEST_WEBHOOK_URL });
  assertEquals(liveResult.code, 1);
  assertStringIncludes(liveResult.stderr, LIVE_WEBHOOK_URL);
});

Deno.test("Stripe setup refuses a cross-environment signing-secret file", async () => {
  const testResult = await runSetup("test", {
    WEBHOOK_SECRET_FILE: ".env.stripe.webhook.live.local",
  });
  assertEquals(testResult.code, 1);
  assertStringIncludes(testResult.stderr, ".env.stripe.webhook.test.local");

  const liveResult = await runSetup("live", {
    WEBHOOK_SECRET_FILE: ".env.stripe.webhook.test.local",
  });
  assertEquals(liveResult.code, 1);
  assertStringIncludes(liveResult.stderr, ".env.stripe.webhook.live.local");
});
