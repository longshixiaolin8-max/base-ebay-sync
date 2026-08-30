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

    addRoute("GetProducts", apigwv2.HttpMethod.GET, "/admin/products", adminIntegration, true);
    addRoute("GetProduct", apigwv2.HttpMethod.GET, "/admin/products/{id}", adminIntegration, true);
    addRoute(
      "ApproveEbayListing",
      apigwv2.HttpMethod.POST,
      "/admin/products/{id}/approve-ebay-listing",
      adminIntegration,
      true,
    );
    addRoute("GetSyncErrors", apigwv2.HttpMethod.GET, "/admin/sync-errors", adminIntegration, true);
    addRoute("RetrySyncError", apigwv2.HttpMethod.POST, "/admin/sync-errors/{id}/retry", adminIntegration, true);
    addRoute("GetAuditLog", apigwv2.HttpMethod.GET, "/admin/audit-log", adminIntegration, true);

    // /authorize kicks off the OAuth consent flow and must only be triggerable by a
    // signed-in admin operator; /callback is hit by BASE/eBay's own redirect (no
    // Cognito session), so it relies on the signed `state` param for CSRF protection.
    addRoute(
      "OauthBaseAuthorize",
      apigwv2.HttpMethod.GET,
      "/oauth/base/authorize",
      new HttpLambdaIntegration("OauthBaseAuthorizeIntegration", props.oauthBaseAuthorizeFn),
      true,
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
      true,
    );
    addRoute(
      "OauthEbayCallback",
      apigwv2.HttpMethod.GET,
      "/oauth/ebay/callback",
      new HttpLambdaIntegration("OauthEbayCallbackIntegration", props.oauthEbayCallbackFn),
      false,
    );
  }
}
