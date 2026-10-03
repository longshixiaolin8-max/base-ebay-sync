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
  /**
   * Confirmed live (a failed prod deploy): the per-route throttle on
   * `POST /webhooks/ebay/platform-notifications/{token}` (ApiStack) is set on the HttpApi's
   * Stage resource, which lives in the separately-deployed ApiCoreStack -- and ApiCoreStack
   * always deploys BEFORE ApiStack (LambdaStack, and therefore the Route itself, needs
   * ApiCoreStack's api.apiEndpoint first). AWS::ApiGatewayV2::Stage's RouteSettings is
   * validated against routes that already exist on the live API at update time, not against
   * anything CloudFormation can order via Ref/GetAtt (routeSettings' route key is a plain
   * string, not a resource reference) -- so the very first deploy that introduces this
   * route+throttle combination always fails with "Unable to find Route by key ... within the
   * provided RouteSettings", because ApiCoreStack's Stage update runs before ApiStack has
   * ever created the Route. Reversing the dependency (making the Route deploy first) isn't
   * possible either: ApiStack already depends on ApiCoreStack for the api object itself, and
   * CDK/CloudFormation stacks can't depend on each other both ways.
   *
   * The only safe path is two deploys: false (default) the first time so the Route gets
   * created with no throttle override; then true on a later deploy, once that Route already
   * exists in AWS from the first deploy, so the Stage update can reference it successfully.
   * See README's "eBay Platform Notification abuse対策" section for the exact steps.
   */
  ebayPlatformNotificationThrottleEnabled: boolean;
  /**
   * The "From" address stripe-webhook's billing-notice emails (payment failed, subscription
   * canceled) are sent from via SES v2 -- see services/lambdas/shared/src/email.ts. Left
   * unset by default: sendEmail() throws (caught, logged, never fails the webhook response)
   * until this is both set here AND the address/domain has been verified in the SES console
   * for this account/region -- a manual, outside-this-codebase step (DNS records for domain
   * verification, or a one-click confirmation for single-address verification) that mirrors
   * every other "CDK provisions capability, a human fills in config after deploy" credential
   * in this stack (see README's SES setup notes).
   */
  sesFromEmail?: string;
  /**
   * Confirmed live (a failed dev deploy): this account's Lambda "Concurrent executions"
   * quota is NOT the AWS default of 1000 -- it was 10, the lowest AWS allows, most likely
   * because a fresh/lightly-used account hasn't yet had it auto-raised. AWS enforces a hard
   * floor of 10 *unreserved* executions account-wide, so on an account capped at 10 total,
   * reserving even a single unit for one function is mathematically impossible ("decreases
   * account's UnreservedConcurrentExecution below its minimum value of [10]"). makeFn's own
   * reservedConcurrency argument (lambda-stack.ts) is therefore only actually applied when
   * this is true -- false (default) leaves every Lambda unreserved, exactly like before that
   * feature existed, so a low-quota account can still deploy everything else. A quota
   * increase request to 1000 was filed via Service Quotas (RequestServiceQuotaIncrease,
   * lambda/L-B99A9384) but isn't guaranteed to be approved automatically or quickly -- flip
   * this to true only after confirming (GetServiceQuota) the account's live quota is
   * comfortably above the sum of every reservedConcurrency value this stack sets.
   */
  lambdaConcurrencyLimitsEnabled: boolean;
}

export function loadConfig(
  envName: string,
  alarmEmail?: string,
  aiProvider?: string,
  monthlyBudgetUsd?: string,
  apiEntrypoint?: string,
  ebayPlatformNotificationThrottleEnabled?: string,
  sesFromEmail?: string,
  lambdaConcurrencyLimitsEnabled?: string,
): PlatformConfig {
  return {
    envName,
    alarmEmail,
    aiProvider: aiProvider === "openai" ? "openai" : "bedrock",
    monthlyBudgetUsd: monthlyBudgetUsd ? Number(monthlyBudgetUsd) : 50,
    apiEntrypoint: apiEntrypoint === "cloudfront" ? "cloudfront" : "direct",
    ebayPlatformNotificationThrottleEnabled: ebayPlatformNotificationThrottleEnabled === "true",
    sesFromEmail,
    lambdaConcurrencyLimitsEnabled: lambdaConcurrencyLimitsEnabled === "true",
  };
}
