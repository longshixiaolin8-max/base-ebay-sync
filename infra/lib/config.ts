export interface PlatformConfig {
  envName: string;
  /** Email address that receives CloudWatch alarm notifications (DLQ depth, Lambda errors). */
  alarmEmail?: string;
  /** AI backend: "bedrock" (default, no external API key needed) or "openai". */
  aiProvider: "bedrock" | "openai";
  /** Monthly AWS Budgets threshold (whole account, USD) that triggers an alarm-topic
   *  notification. AWS Budgets' first two budgets per account are free. */
  monthlyBudgetUsd: number;
  /**
   * Round 15 hardening ("WAFを実際の本番経路に適用"). "direct" (default): every URL this
   * platform hands to itself or external services (BASE_OAUTH_REDIRECT_URI, the eBay
   * webhook destinations, the admin app's API base URL) is the raw execute-api endpoint,
   * exactly today's live behavior -- WAF stays stood up but unused. "cloudfront": the same
   * URLs instead point at the WAF-protected CloudFront distribution.
   *
   * Deliberately NOT flipped by this round itself: BASE's OAuth redirect_uri is registered
   * in BASE's own developer console (outside this codebase's control), and Stripe's webhook
   * endpoint is registered in Stripe's dashboard -- switching apiUrl here without first
   * updating those consoles would break new BASE OAuth connections and Stripe webhook
   * delivery immediately on deploy. See README's own runbook for the exact, ordered cutover
   * steps once those external updates are ready.
   */
  apiEntrypoint: "direct" | "cloudfront";
}

export function loadConfig(
  envName: string,
  alarmEmail?: string,
  aiProvider?: string,
  monthlyBudgetUsd?: string,
  apiEntrypoint?: string,
): PlatformConfig {
  return {
    envName,
    alarmEmail,
    aiProvider: aiProvider === "openai" ? "openai" : "bedrock",
    monthlyBudgetUsd: monthlyBudgetUsd ? Number(monthlyBudgetUsd) : 50,
    apiEntrypoint: apiEntrypoint === "cloudfront" ? "cloudfront" : "direct",
  };
}
