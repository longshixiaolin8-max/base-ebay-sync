import * as cdk from "aws-cdk-lib";
import * as apigwv2 from "aws-cdk-lib/aws-apigatewayv2";
import { HttpLambdaIntegration } from "aws-cdk-lib/aws-apigatewayv2-integrations";
import { HttpJwtAuthorizer } from "aws-cdk-lib/aws-apigatewayv2-authorizers";
import type * as cognito from "aws-cdk-lib/aws-cognito";
import type * as nodejs from "aws-cdk-lib/aws-lambda-nodejs";
import type { Construct } from "constructs";

export interface ApiStackProps extends cdk.StackProps {
  userPool: cognito.UserPool;
  userPoolClient: cognito.UserPoolClient;
  adminApiFn: nodejs.NodejsFunction;
  oauthBaseAuthorizeFn: nodejs.NodejsFunction;
  oauthBaseCallbackFn: nodejs.NodejsFunction;
  oauthEbayAuthorizeFn: nodejs.NodejsFunction;
  oauthEbayCallbackFn: nodejs.NodejsFunction;
}

export class ApiStack extends cdk.Stack {
  readonly api: apigwv2.HttpApi;

  constructor(scope: Construct, id: string, props: ApiStackProps) {
    super(scope, id, props);

    this.api = new apigwv2.HttpApi(this, "PlatformApi", {
      corsPreflight: {
        allowMethods: [apigwv2.CorsHttpMethod.GET, apigwv2.CorsHttpMethod.POST],
        allowOrigins: ["*"], // tightened to the Amplify-hosted admin origin post-deploy
        allowHeaders: ["Authorization", "Content-Type"],
      },
    });

    const authorizer = new HttpJwtAuthorizer("AdminAuthorizer", `https://cognito-idp.${this.region}.amazonaws.com/${props.userPool.userPoolId}`, {
      jwtAudience: [props.userPoolClient.userPoolClientId],
    });

    const adminIntegration = new HttpLambdaIntegration("AdminApiIntegration", props.adminApiFn);
    const authOptions = { authorizer };

    for (const routeKey of [
      "GET /admin/products",
      "GET /admin/products/{id}",
      "POST /admin/products/{id}/approve-ebay-listing",
      "GET /admin/sync-errors",
      "POST /admin/sync-errors/{id}/retry",
      "GET /admin/audit-log",
    ]) {
      const [method, path] = routeKey.split(" ") as [string, string];
      this.api.addRoutes({
        path,
        methods: [method as apigwv2.HttpMethod],
        integration: adminIntegration,
        ...authOptions,
      });
    }

    // /authorize kicks off the OAuth consent flow and must only be triggerable by a
    // signed-in admin operator; /callback is hit by BASE/eBay's own redirect (no
    // Cognito session), so it relies on the signed `state` param for CSRF protection.
    this.api.addRoutes({
      path: "/oauth/base/authorize",
      methods: [apigwv2.HttpMethod.GET],
      integration: new HttpLambdaIntegration("OauthBaseAuthorizeIntegration", props.oauthBaseAuthorizeFn),
      authorizer,
    });
    this.api.addRoutes({
      path: "/oauth/base/callback",
      methods: [apigwv2.HttpMethod.GET],
      integration: new HttpLambdaIntegration("OauthBaseCallbackIntegration", props.oauthBaseCallbackFn),
    });
    this.api.addRoutes({
      path: "/oauth/ebay/authorize",
      methods: [apigwv2.HttpMethod.GET],
      integration: new HttpLambdaIntegration("OauthEbayAuthorizeIntegration", props.oauthEbayAuthorizeFn),
      authorizer,
    });
    this.api.addRoutes({
      path: "/oauth/ebay/callback",
      methods: [apigwv2.HttpMethod.GET],
      integration: new HttpLambdaIntegration("OauthEbayCallbackIntegration", props.oauthEbayCallbackFn),
    });

    new cdk.CfnOutput(this, "ApiUrl", { value: this.api.apiEndpoint });
  }
}
