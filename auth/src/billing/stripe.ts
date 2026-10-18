import Stripe from "stripe";
import { env } from "../config/env";

let client: Stripe | null = env.billing
  ? new Stripe(env.billing.secretKey, {
      maxNetworkRetries: 2,
      appInfo: { name: "Patenter" },
    })
  : null;

// Null when billing isn't configured (no STRIPE_SECRET_KEY).
export function getStripe() {
  return client;
}

// For tests: swaps in a client whose API calls are faked.
export function setStripe(next: Stripe | null) {
  client = next;
}
