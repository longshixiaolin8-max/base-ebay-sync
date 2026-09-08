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
  oauthBaseAuthorizeFn: nodejs.NodejsFunction;
  oauthBaseCallbackFn: nodejs.NodejsFunction;
  oauthEbayAuthorizeFn: nodejs.NodejsFunction;
  oauthEbayCallbackFn: nodejs.NodejsFunction;
  ebayWebhookFn: nodejs.NodejsFunction;
  signupHandlerFn: nodejs.NodejsFunction;
  stripeWebhookFn: nodejs.NodejsFunction;
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

    // /authorize only builds a signed `state` and 302s to BASE/eBay's own consent screen --
    // no state-changing action happens here. It was originally gated behind Cognito on the
    // assumption the admin app would call it with a session token, but no such UI was ever
    // built, so a plain browser visit (the only way this is actually used) always 401'd.
    // /callback (BASE/eBay's own redirect target, which never carries a Cognito session
    // either) already relies on the signed `state` param for CSRF protection, not Cognito --
    // /authorize is unauthenticated for the same reason and with the same protection.
    addRoute(
      "OauthBaseAuthorize",
      apigwv2.HttpMethod.GET,
      "/oauth/base/authorize",
      new HttpLambdaIntegration("OauthBaseAuthorizeIntegration", props.oauthBaseAuthorizeFn),
      false,
    );
    addRoute(
      "OauthBaseCallback",
      apigwv2.HttpMethod.GET,
      "/oauth/base/callback",
      new HttpLambdaIntegration("OauthBaseCallbackIntegration", props.oauthBaseCallbackFn),
      false,
    );
    addRoute(
      "OauthEbayAuthorize",
      apigwv2.HttpMethod.GET,
      "/oauth/ebay/authorize",
      new HttpLambdaIntegration("OauthEbayAuthorizeIntegration", props.oauthEbayAuthorizeFn),
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

    // Public: this is what creates a Cognito session in the first place, so no session can
    // exist yet. Gated instead by a shared invite code checked inside the handler.
    addRoute(
      "Signup",
      apigwv2.HttpMethod.POST,
      "/signup",
      new HttpLambdaIntegration("SignupIntegration", props.signupHandlerFn),
      false,
    );

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
