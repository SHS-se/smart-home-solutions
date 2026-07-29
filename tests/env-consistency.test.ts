import { assertEquals, assertStringIncludes } from "https://deno.land/std@0.224.0/assert/mod.ts";
import { checkEnvConsistency, SUPABASE_PROJECT_REFS } from "../src/lib/env-consistency.ts";

function envFor(appEnv: "test" | "live"): Record<string, string> {
  const ref = SUPABASE_PROJECT_REFS[appEnv];
  return {
    VITE_APP_ENV: appEnv,
    VITE_SUPABASE_PROJECT_ID: ref,
    VITE_SUPABASE_URL: `https://${ref}.supabase.co`,
    VITE_STRIPE_PUBLISHABLE_KEY: appEnv === "test" ? "pk_test_example" : "pk_live_example",
  };
}

Deno.test("a coherent test or live environment passes", () => {
  assertEquals(checkEnvConsistency(envFor("test")), []);
  assertEquals(checkEnvConsistency(envFor("live")), []);
});

Deno.test("a missing Stripe key is allowed (UI degrades gracefully)", () => {
  const env = envFor("live");
  delete env.VITE_STRIPE_PUBLISHABLE_KEY;
  assertEquals(checkEnvConsistency(env), []);
});

Deno.test("a missing or unknown VITE_APP_ENV is refused outright", () => {
  const unset = checkEnvConsistency({});
  assertEquals(unset.length, 1);
  assertStringIncludes(unset[0], "VITE_APP_ENV");

  const typo = checkEnvConsistency({ ...envFor("live"), VITE_APP_ENV: "prod" });
  assertEquals(typo.length, 1);
  assertStringIncludes(typo[0], '"prod"');
});

Deno.test("a live environment pointing at the test Supabase project is refused", () => {
  const env = {
    ...envFor("live"),
    VITE_SUPABASE_PROJECT_ID: SUPABASE_PROJECT_REFS.test,
    VITE_SUPABASE_URL: `https://${SUPABASE_PROJECT_REFS.test}.supabase.co`,
  };
  const problems = checkEnvConsistency(env);
  assertEquals(problems.length, 2);
  assertStringIncludes(problems[0], SUPABASE_PROJECT_REFS.live);
  assertStringIncludes(problems[1], SUPABASE_PROJECT_REFS.live);
});

Deno.test("a Stripe key from the opposite mode is refused", () => {
  const testEnv = { ...envFor("test"), VITE_STRIPE_PUBLISHABLE_KEY: "pk_live_example" };
  assertStringIncludes(checkEnvConsistency(testEnv)[0], "pk_test_");

  const liveEnv = { ...envFor("live"), VITE_STRIPE_PUBLISHABLE_KEY: "pk_test_example" };
  assertStringIncludes(checkEnvConsistency(liveEnv)[0], "pk_live_");
});

Deno.test("a malformed Supabase URL is refused even with the right project id", () => {
  const env = { ...envFor("live"), VITE_SUPABASE_URL: "https://example.com" };
  const problems = checkEnvConsistency(env);
  assertEquals(problems.length, 1);
  assertStringIncludes(problems[0], "VITE_SUPABASE_URL");
});
