import { loadStripe, type Stripe } from '@stripe/stripe-js';

// Lazily load Stripe.js with our publishable key (public, shipped to the browser
// by design). Returns null if the key is unset so the UI can degrade gracefully.
let stripePromise: Promise<Stripe | null> | null = null;

export function getStripe(): Promise<Stripe | null> {
  if (!stripePromise) {
    const key = import.meta.env.VITE_STRIPE_PUBLISHABLE_KEY as string | undefined;
    stripePromise = key ? loadStripe(key) : Promise.resolve(null);
  }
  return stripePromise;
}
