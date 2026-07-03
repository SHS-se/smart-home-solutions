export const SUBSCRIPTION_PRICE_LOOKUP_KEY = "shs_subscription_monthly";

export interface SubscriptionProductDetails {
  name: string | null;
  amount: number | null;
  currency: string | null;
  interval: string | null;
  interval_count: number | null;
}

interface StripeProductLike {
  name?: unknown;
}

interface StripePriceLike {
  unit_amount?: number | null;
  unit_amount_decimal?: string | null;
  currency?: string | null;
  recurring?: {
    interval?: string | null;
    interval_count?: number | null;
  } | null;
  product?: string | StripeProductLike | null;
}

interface StripeSubscriptionLike {
  items?: {
    data?: Array<{
      price?: StripePriceLike | null;
    }>;
  };
}

interface StripeClientLike {
  prices: {
    list(args: {
      lookup_keys: string[];
      active: boolean;
      limit: number;
      expand?: string[];
    }): Promise<{ data: StripePriceLike[] }>;
  };
}

function productName(product: StripePriceLike["product"]): string | null {
  if (!product || typeof product === "string") return null;
  return typeof product.name === "string" && product.name.trim()
    ? product.name
    : null;
}

function priceAmount(price: StripePriceLike): number | null {
  if (typeof price.unit_amount === "number") {
    return price.unit_amount / 100;
  }
  if (price.unit_amount_decimal) {
    const amount = Number(price.unit_amount_decimal);
    return Number.isFinite(amount) ? amount / 100 : null;
  }
  return null;
}

export function subscriptionProductFromPrice(
  price: StripePriceLike | null | undefined,
): SubscriptionProductDetails | null {
  if (!price) return null;

  return {
    name: productName(price.product),
    amount: priceAmount(price),
    currency: price.currency ?? null,
    interval: price.recurring?.interval ?? null,
    interval_count: price.recurring?.interval_count ?? null,
  };
}

export function subscriptionProductFromSubscription(
  subscription: StripeSubscriptionLike,
): SubscriptionProductDetails | null {
  return subscriptionProductFromPrice(subscription.items?.data?.[0]?.price);
}

export async function loadActiveSubscriptionProduct(
  stripe: StripeClientLike,
): Promise<SubscriptionProductDetails | null> {
  const prices = await stripe.prices.list({
    lookup_keys: [SUBSCRIPTION_PRICE_LOOKUP_KEY],
    active: true,
    limit: 1,
    expand: ["data.product"],
  });

  return subscriptionProductFromPrice(prices.data[0]);
}
