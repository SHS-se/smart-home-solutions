import { assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import {
  subscriptionProductFromPrice,
  subscriptionProductFromSubscription,
} from "../supabase/functions/_shared/subscription-product.ts";

Deno.test("subscriptionProductFromPrice maps expanded Stripe price details", () => {
  const product = subscriptionProductFromPrice({
    unit_amount: 39900,
    currency: "sek",
    recurring: { interval: "month", interval_count: 1 },
    product: { name: "Smart Home Care" },
  });

  assertEquals(product, {
    name: "Smart Home Care",
    amount: 399,
    currency: "sek",
    interval: "month",
    interval_count: 1,
  });
});

Deno.test("subscriptionProductFromSubscription reads the active subscription item price", () => {
  const product = subscriptionProductFromSubscription({
    items: {
      data: [
        {
          price: {
            unit_amount: 119900,
            currency: "sek",
            recurring: { interval: "year", interval_count: 1 },
            product: { name: "Annual service plan" },
          },
        },
      ],
    },
  });

  assertEquals(product?.name, "Annual service plan");
  assertEquals(product?.amount, 1199);
  assertEquals(product?.interval, "year");
});
