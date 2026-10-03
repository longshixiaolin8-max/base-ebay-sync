import * as cdk from "aws-cdk-lib";
import * as apigwv2 from "aws-cdk-lib/aws-apigatewayv2";
import { HttpLambdaIntegration } from "aws-cdk-lib/aws-apigatewayv2-integrations";
import { HttpJwtAuthorizer } from "aws-cdk-lib/aws-apigatewayv2-authorizers";
import type * as cognito from "aws-cdk-lib/aws-cognito";
import type * as nodejs from "aws-cdk-lib/aws-lambda-nodejs";
import type { Construct } from "constructs";

export interface ApiStackProps extends cdk.StackProps {
  api: apigwv2.HttpApi;
  userPool: cognito.UserPool;
  userPoolClient: cognito.UserPoolClient;
  adminApiFn: nodejs.NodejsFunction;
  oauthBaseCallbackFn: nodejs.NodejsFunction;
  oauthEbayCallbackFn: nodejs.NodejsFunction;
  ebayWebhookFn: nodejs.NodejsFunction;
  signupHandlerFn: nodejs.NodejsFunction;
  stripeWebhookFn: nodejs.NodejsFunction;
  /** See PlatformConfig.ebayPlatformNotificationThrottleEnabled's doc comment: must stay
   *  false on an environment's first-ever deploy of the platform-notifications route. */
  enableEbayPlatformNotificationThrottle: boolean;
}

/**
 * Adds routes to the HttpApi created in ApiCoreStack. Routes are built via the `HttpRoute`
 * construct directly (rather than the `api.addRoutes()` convenience method) so they are
 * explicitly parented to *this* stack: `addRoutes()` parents its Route/Integration
 * constructs under the HttpApi construct itself, which lives in ApiCoreStack — that would
 * make ApiCoreStack reference these Lambda ARNs, creating a cycle with LambdaStack's own
 * dependency on ApiCoreStack's apiEndpoint (used for the BASE OAuth redirect_uri).
 */
export class ApiStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props: ApiStackProps) {
    super(scope, id, props);

    const api = props.api;

    const authorizer = new HttpJwtAuthorizer("AdminAuthorizer", `https://cognito-idp.${this.region}.amazonaws.com/${props.userPool.userPoolId}`, {
      jwtAudience: [props.userPoolClient.userPoolClientId],
    });

    const adminIntegration = new HttpLambdaIntegration("AdminApiIntegration", props.adminApiFn);

    const addRoute = (
      routeId: string,
      method: apigwv2.HttpMethod,
      path: string,
      integration: apigwv2.HttpRouteIntegration,
      withAuth: boolean,
    ) => {
      new apigwv2.HttpRoute(this, routeId, {
        httpApi: api,
        routeKey: apigwv2.HttpRouteKey.with(path, method),
        integration,
        authorizer: withAuth ? authorizer : undefined,
      });
    };

    // Every /admin/* route (GET and POST) is collapsed into these two catch-all routes
    // rather than one explicit HttpRoute per endpoint. admin-api's handler already does its
    // own internal routing by reading event.rawPath/requestContext.http.method directly (not
    // API Gateway path parameters), so this changes nothing about route behavior -- it's a
    // CDK-layer fix only. It's required, not a style choice: API Gateway's Lambda proxy
    // integration grants one resource-policy statement per distinct HttpRoute, and the 47+
    // explicit /admin/* routes this API had accumulated pushed adminApiFn's resource policy
    // past Lambda's hard 20KB size limit the moment Phase 2 added two more routes. Two
    // catch-all routes need only two statements, independent of how many logical endpoints
    // admin-api's own handler serves.
    addRoute("AdminApiGet", apigwv2.HttpMethod.GET, "/admin/{proxy+}", adminIntegration, true);
    addRoute("AdminApiPost", apigwv2.HttpMethod.POST, "/admin/{proxy+}", adminIntegration, true);
    addRoute("AdminApiPatch", apigwv2.HttpMethod.PATCH, "/admin/{proxy+}", adminIntegration, true);

    // Round 12 hardening ("public OAuth authorize routeを廃止"): the old public
    // GET /oauth/{base,ebay}/authorize routes (unauthenticated, minted state for the fixed
    // BOOTSTRAP_TENANT_ID only) are gone -- OAuth connect now always starts from
    // admin-api's authenticated GET /admin/oauth/{base,ebay}/authorize-url, which mints
    // that same signed state for the *caller's own* tenantId instead of a client-supplied
    // (or hardcoded) one. Only /callback stays here and stays public: it's BASE/eBay's own
    // redirect target, which never carries a Cognito session either -- its protection is
    // verifyState's signed, tenant-bound, time-limited state, not this route's auth gate.
    addRoute(
      "OauthBaseCallback",
      apigwv2.HttpMethod.GET,
      "/oauth/base/callback",
      new HttpLambdaIntegration("OauthBaseCallbackIntegration", props.oauthBaseCallbackFn),
      false,
    );
    addRoute(
      "OauthEbayCallback",
      apigwv2.HttpMethod.GET,
      "/oauth/ebay/callback",
      new HttpLambdaIntegration("OauthEbayCallbackIntegration", props.oauthEbayCallbackFn),
      false,
    );

    // Hit directly by eBay's Notification API (endpoint-ownership challenge on GET,
    // event delivery on POST) — no Cognito session exists on either call, so authenticity
    // relies on the X-EBAY-SIGNATURE verification inside the handler itself, not this gate.
    const ebayWebhookIntegration = new HttpLambdaIntegration("EbayWebhookIntegration", props.ebayWebhookFn);
    addRoute("EbayWebhookChallenge", apigwv2.HttpMethod.GET, "/webhooks/ebay/notifications", ebayWebhookIntegration, false);
    addRoute("EbayWebhookNotify", apigwv2.HttpMethod.POST, "/webhooks/ebay/notifications", ebayWebhookIntegration, false);
    // Production-readiness fix: the bare path above has no per-tenant hint at all (eBay's
    // REST Notification API payload never carries one), so it was hardcoded to
    // BOOTSTRAP_TENANT_ID -- fine for a single-tenant deploy, silently wrong for a 2nd real
    // tenant. Same per-tenant signed-token pattern as EbayPlatformNotify below: admin-api's
    // POST /admin/ebay/webhook-setup now registers each tenant's own
    // .../notifications/{token} destination URL instead of the shared bare one. The bare
    // routes above stay live (not removed) so the one destination already registered under
    // the old URL keeps working unchanged -- this is purely additive, not a breaking cutover.
    addRoute("EbayWebhookChallengeTokened", apigwv2.HttpMethod.GET, "/webhooks/ebay/notifications/{token}", ebayWebhookIntegration, false);
    addRoute("EbayWebhookNotifyTokened", apigwv2.HttpMethod.POST, "/webhooks/ebay/notifications/{token}", ebayWebhookIntegration, false);
    // Delivery target for the legacy Trading API's Platform Notifications (FixedPriceTransaction),
    // a wholly different mechanism from the REST Notification API routes above -- no
    // X-EBAY-SIGNATURE or other per-request crypto verification exists for this delivery
    // mechanism. Round 14 hardening ("eBay Platform Notification abuse対策"): the {token}
    // path segment is this route's own authenticity check instead -- a per-tenant, signed
    // (HMAC, this app's eBay client secret) token minted once at subscription time (see
    // admin-api's POST /admin/ebay/platform-notification-setup), verified inside
    // handlePlatformNotification. A guess against the old fully-static path could reach a
    // real tenant's poll; a guess against this one can't forge a valid signature.
    addRoute(
      "EbayPlatformNotify",
      apigwv2.HttpMethod.POST,
      "/webhooks/ebay/platform-notifications/{token}",
      ebayWebhookIntegration,
      false,
    );
    // Tighter than ApiCoreStack's blanket default-route throttle (50 rps/100 burst, sized
    // for this whole small internal API): legitimate traffic here is one eBay notification
    // per real sale event on one connected account, nowhere near this. A real abuse flood
    // still amplifies into this route's own SQS queue depth rather than synchronous eBay
    // API calls (see triggerCoalescedPoll), but capping requests/sec here too means a flood
    // can't even burn through this API's shared default-route budget and start 429-ing
    // every other tenant's legitimate traffic on unrelated routes.
    //
    // Confirmed live (a failed prod deploy, twice): this reaches into ApiCoreStack's own
    // CfnStage construct, so the property lands in ApiCoreStack's synthesized template
    // regardless of which stack's file the mutation is written in -- but ApiCoreStack always
    // deploys BEFORE this stack (LambdaStack, and therefore this Route, needs ApiCoreStack's
    // api.apiEndpoint first; see infra/bin/infra.ts). AWS::ApiGatewayV2::Stage validates
    // RouteSettings against routes that already exist on the live API, and the route key here
    // is a plain string CloudFormation can't turn into a Ref/GetAtt dependency, so on an
    // environment's first-ever deploy of this route, ApiCoreStack's Stage update runs before
    // this stack has ever created the Route -- and fails with "Unable to find Route by key
    // ... within the provided RouteSettings". There is no way to flip the stack order instead
    // (this stack already depends on ApiCoreStack for the api object itself; CloudFormation
    // stacks can't depend on each other both ways), so PlatformConfig.
    // ebayPlatformNotificationThrottleEnabled (default false) gates this entirely: leave it
    // off for the deploy that creates the Route, then turn it on for a later one, once that
    // Route already exists in AWS and the Stage update can reference it successfully. See
    // README's "eBay Platform Notification abuse対策" section for the exact steps.
    const cfnStage = api.defaultStage?.node.defaultChild as apigwv2.CfnStage | undefined;
    if (cfnStage && props.enableEbayPlatformNotificationThrottle) {
      // Unlike defaultRouteSettings (a plain typed property CDK's own mapper translates
      // camelCase -> PascalCase for), routeSettings is a free-form
      // { [routeKey]: RouteSettingsProperty } map that CDK passes through to CloudFormation
      // without translating each value's keys -- the real API Gateway resource handler only
      // accepts the PascalCase CloudFormation property names here ("Unrecognized field
      // \"throttlingBurstLimit\"... 5 known properties: \"ThrottlingBurstLimit\",
      // \"ThrottlingRateLimit\", ..."). Cast past the (misleadingly camelCase-typed)
      // interface to use the names CloudFormation actually expects.
      cfnStage.routeSettings = {
        ...cfnStage.routeSettings,
        "POST /webhooks/ebay/platform-notifications/{token}": {
          ThrottlingRateLimit: 5,
          ThrottlingBurstLimit: 10,
        } as unknown as apigwv2.CfnStage.RouteSettingsProperty,
      };
    }

    // Public acquisition endpoints. POST /signup uses Cognito's native verification
    // code flow before Stripe Checkout; GET /public/pricing returns only non-secret Stripe
    // price metadata so the landing/signup UI never hardcodes a price that can drift.
    const signupIntegration = new HttpLambdaIntegration("SignupIntegration", props.signupHandlerFn);
    addRoute("Signup", apigwv2.HttpMethod.POST, "/signup", signupIntegration, false);
    addRoute("PublicPricing", apigwv2.HttpMethod.GET, "/public/pricing", signupIntegration, false);

    // Public: hit directly by Stripe, which carries no Cognito session either -- authenticity
    // relies on the Stripe-Signature verification inside the handler, same pattern as the
    // eBay webhook above.
    addRoute(
      "StripeWebhook",
      apigwv2.HttpMethod.POST,
      "/webhooks/stripe",
      new HttpLambdaIntegration("StripeWebhookIntegration", props.stripeWebhookFn),
      false,
    );
  }
}
