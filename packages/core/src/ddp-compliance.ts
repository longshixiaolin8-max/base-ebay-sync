/**
 * eBay announced (effective October 17, 2025) that sellers shipping from Japan or Korea to
 * the United States must use DDP (Delivered Duty Paid) customs clearance for any shipment
 * with a unit price under US$2,500 -- a response to the US ending its de minimis exemption,
 * which otherwise leaves the buyer hit with an unexpected customs bill on delivery. A seller
 * who ships such an order without DDP bears responsibility if the buyer disputes it, and risks
 * selling restrictions on repeat disputes. Items shipped via eBay's own Authenticity Guaranty
 * are exempt, but this platform has no way to detect that from order data, so it is not
 * checked here -- a human reviewing the flag already knows whether a given order went through
 * Authenticity Guaranty.
 *
 * This is a heuristic read of this platform's own already-stored order fields, not a customs
 * determination -- it only surfaces something for the merchant to double-check before shipping
 * (see assessCustomsRisk for the same "AI flags, human decides" posture applied to item
 * content rather than shipment destination/price).
 */

export type DdpComplianceStatus = "required" | "not_required" | "unknown";

export interface DdpAssessmentInput {
  channel: string;
  /** ISO 3166-1 alpha-2 country code of the shipping destination, when known. eBay's
   *  Fulfillment API exposes this under the order's shipTo address, but that address has been
   *  reported empty on some live orders (a known eBay API issue) -- treat a missing value as
   *  "unknown", never as "not required", so a real DDP-required order never silently loses
   *  its warning because of an upstream data gap. */
  shipToCountryCode?: string | null;
  /** This line item's sale price in USD cents, when the channel's orders API provided one --
   *  already scaled by quantity (eBay's own lineItem.total), NOT a per-unit price. */
  salePriceUsdCents?: number | null;
  /** Units on this line item. The $2,500 threshold applies per unit, not to the line's total
   *  -- two $1,500 units must still be flagged even though their $3,000 total clears it. */
  quantity: number;
  /** When the order was placed -- orders placed before the policy's effective date are not
   *  subject to it. */
  placedAt: Date;
}

export interface DdpAssessmentResult {
  status: DdpComplianceStatus;
  reasonJa: string;
}

/** 2025-10-17, the policy's own stated effective date (per eBay's Japan/Korea-to-US shipping
 *  policy page), in UTC. */
const DDP_POLICY_EFFECTIVE_AT = new Date("2025-10-17T00:00:00Z");
const DDP_THRESHOLD_USD_CENTS = 250_000; // US$2,500

export function assessDdpRequirement(input: DdpAssessmentInput): DdpAssessmentResult {
  if (input.channel !== "ebay") {
    return { status: "not_required", reasonJa: "eBay以外のチャネルのため対象外です。" };
  }
  if (input.placedAt < DDP_POLICY_EFFECTIVE_AT) {
    return { status: "not_required", reasonJa: "DDP義務化(2025年10月17日施行)より前の注文のため対象外です。" };
  }
  if (!input.shipToCountryCode) {
    return {
      status: "unknown",
      reasonJa: "発送先の国情報が取得できていないため、DDP対象かどうか判定できません。eBay側で注文内容をご確認ください。",
    };
  }
  if (input.shipToCountryCode !== "US") {
    return { status: "not_required", reasonJa: "発送先が米国以外のため対象外です。" };
  }
  if (input.salePriceUsdCents == null) {
    return {
      status: "unknown",
      reasonJa: "販売価格の情報が取得できていないため、DDP対象かどうか判定できません。",
    };
  }
  // salePriceUsdCents is the line item's total; the $2,500 threshold is a per-unit price.
  const unitPriceUsdCents = input.salePriceUsdCents / input.quantity;
  if (unitPriceUsdCents >= DDP_THRESHOLD_USD_CENTS) {
    return { status: "not_required", reasonJa: "単価が$2,500以上のため、このDDP義務化の対象外です(別途の正式通関が必要です)。" };
  }
  return {
    status: "required",
    reasonJa:
      "米国向け・単価$2,500未満のため、eBayのDDP(関税前払い)義務化の対象です。DDP対応の配送方法(関税前払いオプション)で発送してください。未対応で発送し紛争が起きた場合、セラー側の責任となり出品制限のリスクがあります。",
  };
}
