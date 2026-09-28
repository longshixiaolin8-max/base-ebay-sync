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
}

export function loadConfig(
  envName: string,
  alarmEmail?: string,
  aiProvider?: string,
  monthlyBudgetUsd?: string,
  apiEntrypoint?: string,
  ebayPlatformNotificationThrottleEnabled?: string,
): PlatformConfig {
  return {
    envName,
    alarmEmail,
    aiProvider: aiProvider === "openai" ? "openai" : "bedrock",
    monthlyBudgetUsd: monthlyBudgetUsd ? Number(monthlyBudgetUsd) : 50,
    apiEntrypoint: apiEntrypoint === "cloudfront" ? "cloudfront" : "direct",
    ebayPlatformNotificationThrottleEnabled: ebayPlatformNotificationThrottleEnabled === "true",
  };
}
