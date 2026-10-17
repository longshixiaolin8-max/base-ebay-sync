import { ApiError } from "./api-client";

/**
 * Maps the error codes admin-api's /admin/billing/* routes actually return (grepped from
 * services/lambdas/admin-api/src/handler.ts) to Japanese guidance. Without this, every
 * billing-route failure surfaced ApiError's raw response body text directly in a toast --
 * e.g. literally `{"error":"billing_not_live"}` -- since ApiError's own `message` is just
 * the unparsed fetch response body (see api-client.ts), not something meant to be shown to
 * an end user as-is.
 */
const BILLING_ERROR_MESSAGE: Record<string, string> = {
  billing_not_live: "現在、本番決済がご利用いただけません。しばらくしてからもう一度お試しください。",
  unknown_plan: "指定されたプランが見つかりません。",
  plan_not_available: "このプランは現在ご利用いただけません。サポートにご連絡ください。",
  billing_email_missing: "請求先メールアドレスが未設定です。テナント情報で設定してから、もう一度お試しください。",
  already_on_plan: "既にこのプランをご利用中です。",
  no_active_subscription: "有効なサブスクリプションが見つかりません。",
  no_stripe_customer: "Stripeの顧客情報が見つかりません。サポートにご連絡ください。",
  checkout_not_required: "お支払いは既に完了しています。",
  not_found: "情報が見つかりませんでした。",
};

/**
 * Extracts admin-api's `{"error": "..."}` JSON body (the shape every route in this codebase
 * returns on failure) and maps it to Japanese guidance. Falls back to `fallback` for an
 * error code this map doesn't recognize, or a body that isn't JSON at all (e.g. a 5xx from
 * API Gateway itself, never this platform's own response) -- the raw response text is never
 * shown to the user either way.
 */
export function billingErrorMessage(err: unknown, fallback: string): string {
  if (err instanceof ApiError) {
    try {
      const parsed = JSON.parse(err.message) as { error?: string };
      if (parsed.error && BILLING_ERROR_MESSAGE[parsed.error]) {
        return BILLING_ERROR_MESSAGE[parsed.error];
      }
    } catch {
      // Not JSON -- fall through to the generic fallback below.
    }
  }
  return fallback;
}
