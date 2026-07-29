import { assertEquals, assertThrows } from "https://deno.land/std@0.224.0/assert/mod.ts";
import { getStripeSecretKey } from "../supabase/functions/_shared/stripe-env.ts";

const STRIPE_ENV_NAMES = ["APP_ENV", "SHS_STRIPE_SECRET_KEY"] as const;

function withStripeEnvironment(
  values: Partial<Record<(typeof STRIPE_ENV_NAMES)[number], string>>,
  run: () => void,
) {
  const previous = new Map(STRIPE_ENV_NAMES.map((name) => [name, Deno.env.get(name)]));
  try {
    for (const name of STRIPE_ENV_NAMES) {
      const value = values[name];
      if (value === undefined) Deno.env.delete(name);
      else Deno.env.set(name, value);
    }
    run();
  } finally {
    for (const name of STRIPE_ENV_NAMES) {
      const value = previous.get(name);
      if (value === undefined) Deno.env.delete(name);
      else Deno.env.set(name, value);
    }
  }
}

Deno.test("test edge functions reject live Stripe secret keys", () => {
  withStripeEnvironment(
    { APP_ENV: "test", SHS_STRIPE_SECRET_KEY: "sk_live_example" },
    () => assertThrows(() => getStripeSecretKey(), Error, "not a test key"),
  );
});

Deno.test("live edge functions reject test Stripe secret keys", () => {
  withStripeEnvironment(
    { APP_ENV: "live", SHS_STRIPE_SECRET_KEY: "sk_test_example" },
    () => assertThrows(() => getStripeSecretKey(), Error, "not a live key"),
  );
});

Deno.test("edge functions accept a matching standard Stripe secret key", () => {
  withStripeEnvironment(
    { APP_ENV: "test", SHS_STRIPE_SECRET_KEY: "sk_test_example" },
    () => assertEquals(getStripeSecretKey(), "sk_test_example"),
  );
  withStripeEnvironment(
    { APP_ENV: "live", SHS_STRIPE_SECRET_KEY: "sk_live_example" },
    () => assertEquals(getStripeSecretKey(), "sk_live_example"),
  );
});
