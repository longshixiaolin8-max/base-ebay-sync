import * as cdk from "aws-cdk-lib";
import * as apigwv2 from "aws-cdk-lib/aws-apigatewayv2";
import * as cloudfront from "aws-cdk-lib/aws-cloudfront";
import * as origins from "aws-cdk-lib/aws-cloudfront-origins";
import type { Construct } from "constructs";

export interface CloudFrontStackProps extends cdk.StackProps {
  api: apigwv2.HttpApi;
  /** ARN of the WAFv2 Web ACL created in WafStack (us-east-1, per its own CLOUDFRONT-scope
   *  requirement) -- passed in via CDK's cross-region stack references. */
  webAclArn: string;
}

/**
 * A WAF-protected entry point that fronts the existing HttpApi (ApiCoreStack) -- added
 * purely additively, alongside (not instead of) the API's existing direct execute-api
 * URL. HttpApi can't take a WAF Web ACL association directly (only a REST API, an ALB, or
 * a CloudFront distribution can), so this is what makes WAF possible at all.
 *
 * Deliberately NOT wired into anything yet: the admin app, BASE's OAuth redirect_uri, and
 * eBay's registered webhook destination all still point at the direct execute-api URL, and
 * stay that way here. BASE's redirect URI is registered in BASE's own developer console
 * (can't be changed from this codebase), so migrating traffic to this new URL needs the
 * user to update that console alongside a future deploy -- this round only stands the new,
 * WAF-protected URL up for that future migration, without touching anything already live.
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
        origin: new origins.HttpOrigin(apiHostname, { protocolPolicy: cloudfront.OriginProtocolPolicy.HTTPS_ONLY }),
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
