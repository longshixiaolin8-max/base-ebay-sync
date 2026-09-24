import * as cdk from "aws-cdk-lib";
import * as wafv2 from "aws-cdk-lib/aws-wafv2";
import type { Construct } from "constructs";

/**
 * AWS WAFv2's CloudFront scope is a hard regional restriction: a Web ACL meant to attach
 * to a CloudFront distribution MUST be created in us-east-1, regardless of which region
 * the protected resource (this platform's API, us-east-2) actually lives in. This stack
 * exists purely to satisfy that constraint -- see CloudFrontStack for the distribution
 * that actually attaches it.
 */
export class WafStack extends cdk.Stack {
  readonly webAcl: wafv2.CfnWebACL;

  constructor(scope: Construct, id: string, props?: cdk.StackProps) {
    super(scope, id, props);

    // Managed rule groups + a rate-based abuse backstop, the same "real protection, not
    // dry-run" posture as every other piece of hardening added this session (e.g. the
    // HttpApi's own throttle in api-core-stack.ts) -- no custom rule logic needed, this is
    // exactly what AWS's own managed rule groups exist for.
    this.webAcl = new wafv2.CfnWebACL(this, "ApiWebAcl", {
      scope: "CLOUDFRONT",
      defaultAction: { allow: {} },
      visibilityConfig: {
        sampledRequestsEnabled: true,
        cloudWatchMetricsEnabled: true,
        metricName: "ApiWebAclDefault",
      },
      rules: [
        {
          name: "AWSManagedRulesCommonRuleSet",
          priority: 1,
          overrideAction: { none: {} },
          statement: {
            managedRuleGroupStatement: { vendorName: "AWS", name: "AWSManagedRulesCommonRuleSet" },
          },
          visibilityConfig: {
            sampledRequestsEnabled: true,
            cloudWatchMetricsEnabled: true,
            metricName: "AWSManagedRulesCommonRuleSet",
          },
        },
        {
          name: "AWSManagedRulesKnownBadInputsRuleSet",
          priority: 2,
          overrideAction: { none: {} },
          statement: {
            managedRuleGroupStatement: { vendorName: "AWS", name: "AWSManagedRulesKnownBadInputsRuleSet" },
          },
          visibilityConfig: {
            sampledRequestsEnabled: true,
            cloudWatchMetricsEnabled: true,
            metricName: "AWSManagedRulesKnownBadInputsRuleSet",
          },
        },
        {
          // 2000 req / 5min per IP -- an abuse backstop, not meant to shape legitimate
          // traffic; this is a small internal-facing API, nowhere near this limit.
          name: "RateLimitPerIp",
          priority: 3,
          action: { block: {} },
          statement: {
            rateBasedStatement: { limit: 2000, aggregateKeyType: "IP" },
          },
          visibilityConfig: {
            sampledRequestsEnabled: true,
            cloudWatchMetricsEnabled: true,
            metricName: "RateLimitPerIp",
          },
        },
      ],
    });

    new cdk.CfnOutput(this, "WebAclArn", { value: this.webAcl.attrArn });
  }
}
