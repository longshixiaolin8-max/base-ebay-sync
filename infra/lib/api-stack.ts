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
    addRoute(
      "DraftCondition",
      apigwv2.HttpMethod.POST,
      "/admin/products/{id}/draft-condition",
      adminIntegration,
      true,
    );
    addRoute("GetSyncErrors", apigwv2.HttpMethod.GET, "/admin/sync-errors", adminIntegration, true);
    addRoute("RetrySyncError", apigwv2.HttpMethod.POST, "/admin/sync-errors/{id}/retry", adminIntegration, true);
    addRoute("EbayLocation", apigwv2.HttpMethod.POST, "/admin/ebay/location", adminIntegration, true);
    addRoute("EbayPolicies", apigwv2.HttpMethod.POST, "/admin/ebay/policies", adminIntegration, true);
    addRoute("EbayInventoryItem", apigwv2.HttpMethod.GET, "/admin/ebay/inventory-item", adminIntegration, true);
    addRoute("EbayOffer", apigwv2.HttpMethod.GET, "/admin/ebay/offer", adminIntegration, true);
    addRoute("EbayWebhookSetup", apigwv2.HttpMethod.POST, "/admin/ebay/webhook-setup", adminIntegration, true);
    addRoute(
      "EbayNotificationTopics",
      apigwv2.HttpMethod.GET,
      "/admin/ebay/notification-topics",
      adminIntegration,
      true,
    );
    addRoute(
      "EbayUnmanagedListings",
      apigwv2.HttpMethod.GET,
      "/admin/ebay/unmanaged-listings",
      adminIntegration,
      true,
    );
    addRoute(
      "LinkEbayListing",
      apigwv2.HttpMethod.POST,
      "/admin/products/{id}/link-ebay-listing",
      adminIntegration,
      true,
    );
    addRoute(
      "EbayCategorySuggestions",
      apigwv2.HttpMethod.GET,
      "/admin/ebay/category-suggestions",
      adminIntegration,
      true,
    );
    addRoute("EbayRequiredAspects", apigwv2.HttpMethod.GET, "/admin/ebay/required-aspects", adminIntegration, true);
    addRoute(
      "EbayConditionPolicies",
      apigwv2.HttpMethod.GET,
      "/admin/ebay/condition-policies",
      adminIntegration,
      true,
    );
    addRoute("BaseProduct", apigwv2.HttpMethod.GET, "/admin/base/product", adminIntegration, true);
    addRoute("SyncConfidence", apigwv2.HttpMethod.GET, "/admin/sync/confidence", adminIntegration, true);
    addRoute(
      "DynamicSafetyStock",
      apigwv2.HttpMethod.GET,
      "/admin/products/{id}/dynamic-safety-stock",
      adminIntegration,
      true,
    );
    addRoute("SyncTrace", apigwv2.HttpMethod.GET, "/admin/products/{id}/sync-trace", adminIntegration, true);
    addRoute("StockoutRisk", apigwv2.HttpMethod.GET, "/admin/products/{id}/stockout-risk", adminIntegration, true);
    addRoute("DynamicPrice", apigwv2.HttpMethod.GET, "/admin/products/{id}/dynamic-price", adminIntegration, true);
    addRoute(
      "PricingConfig",
      apigwv2.HttpMethod.POST,
      "/admin/products/{id}/pricing-config",
      adminIntegration,
      true,
    );
    addRoute(
      "GetReconstructInventory",
      apigwv2.HttpMethod.GET,
      "/admin/products/{id}/reconstruct-inventory",
      adminIntegration,
      true,
    );
    addRoute(
      "ApplyReconstructInventory",
      apigwv2.HttpMethod.POST,
      "/admin/products/{id}/reconstruct-inventory",
      adminIntegration,
      true,
    );
    addRoute("GetAuditLog", apigwv2.HttpMethod.GET, "/admin/audit-log", adminIntegration, true);

    // --- Commercial-features round ---
    addRoute("GetOrders", apigwv2.HttpMethod.GET, "/admin/orders", adminIntegration, true);
    addRoute("GetProductOrders", apigwv2.HttpMethod.GET, "/admin/products/{id}/orders", adminIntegration, true);
    addRoute("GetOrderProfit", apigwv2.HttpMethod.GET, "/admin/orders/{id}/profit", adminIntegration, true);
    addRoute("SetOrderStatus", apigwv2.HttpMethod.POST, "/admin/orders/{id}/status", adminIntegration, true);
    addRoute(
      "FinalizeOrderProfit",
      apigwv2.HttpMethod.POST,
      "/admin/orders/{id}/finalize-profit",
      adminIntegration,
      true,
    );
    addRoute(
      "PurchaseInfo",
      apigwv2.HttpMethod.POST,
      "/admin/products/{id}/purchase-info",
      adminIntegration,
      true,
    );
    addRoute(
      "InventoryBreakdown",
      apigwv2.HttpMethod.GET,
      "/admin/products/{id}/inventory-breakdown",
      adminIntegration,
      true,
    );
    addRoute("StaleProducts", apigwv2.HttpMethod.GET, "/admin/stale-products", adminIntegration, true);
    addRoute(
      "StaleSuggestion",
      apigwv2.HttpMethod.POST,
      "/admin/products/{id}/stale-suggestion",
      adminIntegration,
      true,
    );
    addRoute("GetSnsContent", apigwv2.HttpMethod.GET, "/admin/products/{id}/sns", adminIntegration, true);
    addRoute(
      "GenerateSnsScript",
      apigwv2.HttpMethod.POST,
      "/admin/products/{id}/sns/script",
      adminIntegration,
      true,
    );
    addRoute(
      "UpdateSnsStatus",
      apigwv2.HttpMethod.POST,
      "/admin/products/{id}/sns/status",
      adminIntegration,
      true,
    );
    addRoute("SyncState", apigwv2.HttpMethod.GET, "/admin/sync/state", adminIntegration, true);
    addRoute("Slo", apigwv2.HttpMethod.GET, "/admin/slo", adminIntegration, true);
    addRoute("CommerceDashboard", apigwv2.HttpMethod.GET, "/admin/commerce-dashboard", adminIntegration, true);

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
  }
}
