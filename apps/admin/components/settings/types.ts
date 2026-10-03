export interface BillingStatus {
  plan: string;
  status: "pending_payment" | "active" | "past_due" | "canceled_grace" | "canceled";
  testMode: boolean;
  gracePeriodEndsAt: string | null;
}

export interface UsageStatus {
  products: { used: number; limit: number };
  aiGenerations: { used: number; limit: number; periodStart: string };
  monitoredSkus: { used: number; limit: number };
}

export interface PaymentMethod {
  brand: string;
  last4: string;
  expMonth: number;
  expYear: number;
}

export interface Invoice {
  id: string;
  number: string | null;
  /** Stripe minor-unit amount. Kept separately from currency so JPY is never treated as cents. */
  amountMinorUnits: number;
  currency: string;
  /** @deprecated compatibility field for older clients; use amountMinorUnits + currency. */
  amountUsdCents: number;
  createdAt: string;
  status: string | null;
  hostedInvoiceUrl: string | null;
}

export interface BillingDetails {
  paymentMethod: PaymentMethod | null;
  invoices: Invoice[];
  subscription: {
    currentPeriodEnd: string | null;
    cancelAtPeriodEnd: boolean;
    priceAmount: number | null;
    priceCurrency: string | null;
    priceInterval: string | null;
    trialEnd: string | null;
  } | null;
  billingEmail: string | null;
}

export interface TenantInfo {
  id: string;
  name: string;
  address: string | null;
  timezone: string | null;
  language: string | null;
  contactEmail: string | null;
}

export interface NotificationPreferences {
  inventoryDiffAlert: boolean;
  aiDraftCompleted: boolean;
  billingNotice: boolean;
  oauthExpiryNotice: boolean;
  importantNotice: boolean;
}

export interface PricingDefaults {
  defaultShippingCostJpyDomestic: number | null;
  defaultShippingCostJpyIntl: number | null;
  defaultTargetMarginBasisPoints: number | null;
}

export interface ConnectionDetailLite {
  connected: boolean;
  externalAccountId: string | null;
  expiresAt: string | null;
  lastSyncedAt: string | null;
  state: "HEALTHY" | "DEGRADED" | "ISOLATED" | "RECOVERING" | "RECONCILING";
  reasons: string[];
}

export interface ConnectionsResponseLite {
  base: ConnectionDetailLite;
  ebay: ConnectionDetailLite;
}
