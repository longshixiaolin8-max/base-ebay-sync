import * as cdk from "aws-cdk-lib";
import * as apigwv2 from "aws-cdk-lib/aws-apigatewayv2";
import type { Construct } from "constructs";

export interface ApiCoreStackProps extends cdk.StackProps {
  /** The admin app's real hosted origin (e.g. https://deploy.<appId>.amplifyapp.com), once
   *  known -- see AdminHostingStack. CORS stays wildcard only until it's actually known. */
  adminOrigin?: string;
}

/**
 * Just the bare HttpApi, with no routes yet. Split out from ApiStack so its URL is
 * available to LambdaStack (for the BASE OAuth redirect_uri env var) without creating a
 * circular stack dependency — LambdaStack needs this stack's apiEndpoint, and ApiStack
 * (which adds routes pointing at LambdaStack's functions) needs LambdaStack, but neither
 * of those depends on the other.
 */
export class ApiCoreStack extends cdk.Stack {
  readonly api: apigwv2.HttpApi;

  constructor(scope: Construct, id: string, props?: ApiCoreStackProps) {
    super(scope, id, props);

    this.api = new apigwv2.HttpApi(this, "PlatformApi", {
      corsPreflight: {
        // PATCH is real, not future-proofing: admin-api's tenant-settings/notification-
        // preferences/pricing-defaults routes (and apps/admin's apiPatch client) already use
        // it. Found during the production-readiness review -- previously missing here, which
        // would have made the browser's CORS preflight reject every one of those PATCH calls
        // in a real deploy (GET/POST calls never surfaced the gap since this was never tested
        // against live infra with real credentials).
        allowMethods: [apigwv2.CorsHttpMethod.GET, apigwv2.CorsHttpMethod.POST, apigwv2.CorsHttpMethod.PATCH],
        // A wildcard is only ever a bootstrapping fallback for before the admin app has a
        // real hosted origin to restrict to -- now that AdminHostingStack provides one,
        // every real deploy passes it and gets the tightened, single-origin config.
        allowOrigins: props?.adminOrigin ? [props.adminOrigin] : ["*"],
        allowHeaders: ["Authorization", "Content-Type"],
      },
    });

    // Blanket default-route throttle: HttpApi's L2 default stage has no `throttle` prop to
    // set at construction time, so this reaches the underlying L1 to set it post-hoc. Not
    // meant to shape legitimate traffic (this is a small internal admin tool, nowhere near
    // these limits) -- it's a cost/abuse backstop: a runaway retry loop or a leaked bearer
    // token can't run up an unbounded Lambda/RDS Data API bill.
    const cfnStage = this.api.defaultStage?.node.defaultChild as apigwv2.CfnStage | undefined;
    if (cfnStage) {
      cfnStage.defaultRouteSettings = {
        ...cfnStage.defaultRouteSettings,
        throttlingRateLimit: 50,
        throttlingBurstLimit: 100,
      };
    }

    new cdk.CfnOutput(this, "ApiUrl", { value: this.api.apiEndpoint });
  }
}
