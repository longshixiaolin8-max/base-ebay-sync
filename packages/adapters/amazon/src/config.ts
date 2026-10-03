export type AmazonSpApiRegion = "na" | "eu" | "fe";

export interface AmazonAdapterConfig {
  clientId: string;
  clientSecret: string;
  /** The seller's own Amazon marketplace id (e.g. "A1VC38T7YXB528" for amazon.co.jp) --
   *  required on every Listings/Orders API call, not just at OAuth time. */
  marketplaceId: string;
  /** Which of Amazon's 3 SP-API regional endpoints this marketplace belongs to. */
  region?: AmazonSpApiRegion;
}

export const AMAZON_SPAPI_HOST_BY_REGION: Record<AmazonSpApiRegion, string> = {
  na: "https://sellingpartnerapi-na.amazon.com",
  eu: "https://sellingpartnerapi-eu.amazon.com",
  fe: "https://sellingpartnerapi-fe.amazon.com",
};

export const AMAZON_LWA_TOKEN_URL = "https://api.amazon.com/auth/o2/token";
export const AMAZON_SPAPI_DEFAULT_REGION: AmazonSpApiRegion = "fe";

/**
 * SP-API scopes this adapter's method surface needs (Listings Items API, Orders API). Not
 * confirmed against a live registered SP-API application -- verify against Amazon's current
 * "Roles" documentation (developer-docs.amazon.com) before using in a real app registration.
 */
export const AMAZON_SPAPI_ROLES = ["Inventory and Order Tracking", "Product Listing"] as const;
