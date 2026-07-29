// Build-time consistency check for the VITE_* environment: one env file must
// describe ONE environment end to end. A test build must point at the test
// Supabase project and a pk_test_ Stripe key, a live build at the prod project
// and a pk_live_ key. vite.config.ts runs this for every dev serve and build,
// so a mixed env file fails fast instead of shipping a frontend that talks to
// the wrong backend (the runtime guards in environment.ts / stripe.ts remain
// as backstops for bundles built outside that pipeline).

export const SUPABASE_PROJECT_REFS = {
  test: "vxqpgbzseckgceopitpm",
  live: "oosxndduqzhvrorgogaw",
} as const;

const STRIPE_KEY_PREFIXES = {
  test: "pk_test_",
  live: "pk_live_",
} as const;

/** Returns a list of human-readable problems; an empty list means consistent. */
export function checkEnvConsistency(env: Record<string, string | undefined>): string[] {
  const problems: string[] = [];

  const appEnv = env.VITE_APP_ENV;
  if (appEnv !== "test" && appEnv !== "live") {
    problems.push(
      `VITE_APP_ENV must be "test" or "live", got ${JSON.stringify(appEnv)}. ` +
        `Refusing to build without an explicit environment.`,
    );
    // Everything below keys off VITE_APP_ENV, so stop here.
    return problems;
  }

  const expectedRef = SUPABASE_PROJECT_REFS[appEnv];
  const projectId = env.VITE_SUPABASE_PROJECT_ID;
  if (projectId !== expectedRef) {
    problems.push(
      `VITE_APP_ENV is "${appEnv}" but VITE_SUPABASE_PROJECT_ID is ` +
        `${JSON.stringify(projectId)}; expected "${expectedRef}".`,
    );
  }

  const supabaseUrl = env.VITE_SUPABASE_URL;
  const expectedUrl = `https://${expectedRef}.supabase.co`;
  if (supabaseUrl !== expectedUrl) {
    problems.push(
      `VITE_APP_ENV is "${appEnv}" but VITE_SUPABASE_URL is ` +
        `${JSON.stringify(supabaseUrl)}; expected "${expectedUrl}".`,
    );
  }

  // The Stripe key is optional (the UI degrades gracefully without it), but
  // when present it must belong to the same Stripe mode as the environment.
  const stripeKey = env.VITE_STRIPE_PUBLISHABLE_KEY;
  if (stripeKey && !stripeKey.startsWith(STRIPE_KEY_PREFIXES[appEnv])) {
    problems.push(
      `VITE_APP_ENV is "${appEnv}" but VITE_STRIPE_PUBLISHABLE_KEY does not ` +
        `start with "${STRIPE_KEY_PREFIXES[appEnv]}".`,
    );
  }

  return problems;
}
