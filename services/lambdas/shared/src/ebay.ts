import { EBAY_API_SANDBOX_HOST, EBAY_AUTH_SANDBOX_HOST, EbayAdapter } from "@ai-ec/adapter-ebay";

export interface EbayAppCredentials {
  clientId: string;
  clientSecret: string;
  ruName: string;
  merchantLocationKey: string;
  fulfillmentPolicyId?: string;
  paymentPolicyId?: string;
  returnPolicyId?: string;
  /** Shared secret used both to register our Notification API destination and to answer
   * eBay's endpoint-ownership challenge (see EbayAdapter.createNotificationDestination). */
  webhookVerificationToken?: string;
  /** True while testing against eBay's Sandbox environment instead of production. */
  sandbox?: boolean;
}

/** Builds an EbayAdapter pointed at Sandbox or production hosts based on the stored credentials. */
export function createEbayAdapter(creds: EbayAppCredentials): EbayAdapter {
  return new EbayAdapter({
    ...creds,
    apiBaseUrl: creds.sandbox ? EBAY_API_SANDBOX_HOST : undefined,
    authBaseUrl: creds.sandbox ? EBAY_AUTH_SANDBOX_HOST : undefined,
  });
}
