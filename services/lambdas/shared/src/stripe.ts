import Stripe from "stripe";

export interface StripeAppCredentials {
  secretKey: string;
  publishableKey: string;
  priceId: string;
  webhookSigningSecret: string;
}

/** Builds a Stripe SDK client from the stored test-mode credentials (see getAppCredentials("stripe")). */
export function createStripeClient(creds: StripeAppCredentials): Stripe {
  return new Stripe(creds.secretKey);
}
