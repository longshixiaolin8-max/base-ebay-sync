export interface RakutenAdapterConfig {
  /**
   * The platform's own RMS "サービスシークレット" (service secret), issued once per RMS
   * application registration -- analogous to clientSecret elsewhere, but NOT combined with a
   * per-tenant OAuth flow the way BASE/eBay/Shopify/Amazon's clientSecret is. See client.ts's
   * class doc for why.
   */
  serviceSecret: string;
  apiBaseUrl?: string;
}

export const RAKUTEN_RMS_API_DEFAULT_HOST = "https://api.rms.rakuten.co.jp";
