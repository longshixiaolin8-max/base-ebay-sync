import * as cdk from "aws-cdk-lib";
import * as apigwv2 from "aws-cdk-lib/aws-apigatewayv2";
import * as cloudfront from "aws-cdk-lib/aws-cloudfront";
import * as origins from "aws-cdk-lib/aws-cloudfront-origins";
import type * as secretsmanager from "aws-cdk-lib/aws-secretsmanager";
import type { Construct } from "constructs";

export interface CloudFrontStackProps extends cdk.StackProps {
  api: apigwv2.HttpApi;
  /** ARN of the WAFv2 Web ACL created in WafStack (us-east-1, per its own CLOUDFRONT-scope
   *  requirement) -- passed in via CDK's cross-region stack references. */
  webAclArn: string;
  /** Injected as a custom header on every request CloudFront forwards to the origin --
   *  see requireCloudFrontOrigin in services/lambdas/shared/src for the runtime check this
   *  makes possible (HTTP API v2 supports neither a resource policy nor a direct WAF
   *  association, so this is the alternative AWS's own guidance recommends). */
  sharedSecret: secretsmanager.Secret;
}

/**
 * A WAF-protected entry point that fronts the existing HttpApi (ApiCoreStack) -- stood up
 * additively, alongside (not instead of) the API's existing direct execute-api URL: which
 * one is actually used by BASE_OAUTH_REDIRECT_URI / the eBay webhook destinations / the
 * admin app's API base URL is controlled entirely by PlatformConfig.apiEntrypoint
 * ("direct" by default, unchanged from before this stack existed). BASE's redirect URI is
 * registered in BASE's own developer console and Stripe's webhook endpoint in Stripe's own
 * dashboard -- neither can be changed from this codebase, so flipping apiEntrypoint to
 * "cloudfront" needs those external consoles updated first; see README's own runbook for
 * the exact, ordered cutover steps.
 */
export class CloudFrontStack extends cdk.Stack {
  readonly distribution: cloudfront.Distribution;

  constructor(scope: Construct, id: string, props: CloudFrontStackProps) {
    super(scope, id, props);

    // HttpOrigin wants a bare hostname, not the "https://" URL apiEndpoint carries.
    const apiHostname = cdk.Fn.select(2, cdk.Fn.split("/", props.api.apiEndpoint));

    this.distribution = new cloudfront.Distribution(this, "ApiDistribution", {
      webAclId: props.webAclArn,
      defaultBehavior: {
        origin: new origins.HttpOrigin(apiHostname, {
          protocolPolicy: cloudfront.OriginProtocolPolicy.HTTPS_ONLY,
          // CloudFormation resolves this from Secrets Manager at deploy time (a dynamic
          // reference) -- the actual value is never written into this stack's own source,
          // only into the deployed template/Lambda environment, the same trust boundary
          // every other secret in this app already crosses at deploy time.
          customHeaders: { "X-CloudFront-Secret": props.sharedSecret.secretValue.unsafeUnwrap() },
        }),
        viewerProtocolPolicy: cloudfront.ViewerProtocolPolicy.REDIRECT_TO_HTTPS,
        allowedMethods: cloudfront.AllowedMethods.ALLOW_ALL,
        cachePolicy: cloudfront.CachePolicy.CACHING_DISABLED,
        // Forwards every header (critically Authorization, which CloudFront strips by
        // default and admin-api requires on every authenticated route) and query string
        // through unchanged -- this proxies a dynamic API, not static content.
        originRequestPolicy: cloudfront.OriginRequestPolicy.ALL_VIEWER,
      },
    });

    new cdk.CfnOutput(this, "CloudFrontUrl", { value: `https://${this.distribution.domainName}` });
  }
}
