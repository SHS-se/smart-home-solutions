import { assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import { subscriptionInvoiceDescription } from "../supabase/functions/_shared/subscription-invoice-description.ts";

const unix = (date: string) => Date.parse(`${date}T00:00:00Z`) / 1000;

Deno.test("subscriptionInvoiceDescription includes the exact Stripe invoice line period", () => {
  const description = subscriptionInvoiceDescription({
    lines: {
      data: [
        {
          description: "Smart Home Solutions Prenumeration (at 249.00 kr / day)",
          period: {
            start: unix("2026-07-03"),
            end: unix("2026-07-04"),
          },
        },
      ],
    },
  });

  assertEquals(
    description,
    "Smart Home Solutions Prenumeration (at 249.00 kr / day) - Giltighetsperiod: 2026-07-03 - 2026-07-04",
  );
});

Deno.test("subscriptionInvoiceDescription does not duplicate an existing period label", () => {
  const description = subscriptionInvoiceDescription({
    lines: {
      data: [
        {
          description: "Smart Home Solutions - Giltighetsperiod: 2026-07-03 - 2026-07-04",
          period: {
            start: unix("2026-07-03"),
            end: unix("2026-07-04"),
          },
        },
      ],
    },
  });

  assertEquals(description, "Smart Home Solutions - Giltighetsperiod: 2026-07-03 - 2026-07-04");
});
