import * as cdk from "aws-cdk-lib";
import * as apigwv2 from "aws-cdk-lib/aws-apigatewayv2";
import type { Construct } from "constructs";

/**
 * Just the bare HttpApi, with no routes yet. Split out from ApiStack so its URL is
 * available to LambdaStack (for the BASE OAuth redirect_uri env var) without creating a
 * circular stack dependency — LambdaStack needs this stack's apiEndpoint, and ApiStack
 * (which adds routes pointing at LambdaStack's functions) needs LambdaStack, but neither
 * of those depends on the other.
 */
export class ApiCoreStack extends cdk.Stack {
  readonly api: apigwv2.HttpApi;

  constructor(scope: Construct, id: string, props?: cdk.StackProps) {
    super(scope, id, props);

    this.api = new apigwv2.HttpApi(this, "PlatformApi", {
      corsPreflight: {
        allowMethods: [apigwv2.CorsHttpMethod.GET, apigwv2.CorsHttpMethod.POST],
        allowOrigins: ["*"], // tightened to the Amplify-hosted admin origin post-deploy
        allowHeaders: ["Authorization", "Content-Type"],
      },
    });

    new cdk.CfnOutput(this, "ApiUrl", { value: this.api.apiEndpoint });
  }
}
