import { assertEquals, assertThrows } from "https://deno.land/std@0.224.0/assert/mod.ts";
import { validateStripePublishableKey } from "../src/lib/stripe-key-environment.ts";

Deno.test("test builds accept only test Stripe publishable keys", () => {
  assertEquals(validateStripePublishableKey("pk_test_example", "test"), "pk_test_example");
  assertThrows(
    () => validateStripePublishableKey("pk_live_example", "test"),
    Error,
    "pk_test_",
  );
});

Deno.test("live builds accept only live Stripe publishable keys", () => {
  assertEquals(validateStripePublishableKey("pk_live_example", "live"), "pk_live_example");
  assertThrows(
    () => validateStripePublishableKey("pk_test_example", "live"),
    Error,
    "pk_live_",
  );
});

Deno.test("an unset publishable key keeps Stripe disabled", () => {
  assertEquals(validateStripePublishableKey(undefined, "test"), undefined);
  assertEquals(validateStripePublishableKey(undefined, "live"), undefined);
});
