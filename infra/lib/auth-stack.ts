import * as cdk from "aws-cdk-lib";
import * as cognito from "aws-cdk-lib/aws-cognito";
import type { Construct } from "constructs";
import type { PlatformConfig } from "./config.js";

/** Cognito for the admin dashboard only — BASE/eBay OAuth tokens are handled separately. */
export class AuthStack extends cdk.Stack {
  readonly userPool: cognito.UserPool;
  readonly userPoolClient: cognito.UserPoolClient;

  constructor(scope: Construct, id: string, config: PlatformConfig, props?: cdk.StackProps) {
    super(scope, id, props);

    this.userPool = new cognito.UserPool(this, "AdminUserPool", {
      userPoolName: `ai-ec-platform-admin-${config.envName}`,
      // Public SaaS signup uses Cognito's native SignUp/ConfirmSignUp flow so the email
      // address is actually verified before a customer can proceed to Stripe checkout.
      selfSignUpEnabled: true,
      autoVerify: { email: true },
      signInAliases: { email: true },
      standardAttributes: { email: { required: true, mutable: false } },
      customAttributes: {
        tenant_id: new cognito.StringAttribute({ mutable: true }),
      },
      passwordPolicy: {
        minLength: 12,
        requireLowercase: true,
        requireUppercase: true,
        requireDigits: true,
        requireSymbols: true,
      },
      mfa: cognito.Mfa.REQUIRED,
      mfaSecondFactor: { otp: true, sms: false },
      accountRecovery: cognito.AccountRecovery.EMAIL_ONLY,
      removalPolicy: config.envName === "prod" ? cdk.RemovalPolicy.RETAIN : cdk.RemovalPolicy.DESTROY,
      featurePlan: config.envName === "prod" ? cognito.FeaturePlan.PLUS : undefined,
      standardThreatProtectionMode:
        config.envName === "prod" ? cognito.StandardThreatProtectionMode.FULL_FUNCTION : undefined,
    });

    this.userPoolClient = this.userPool.addClient("AdminUserPoolClient", {
      authFlows: { userSrp: true },
      generateSecret: false,
      accessTokenValidity: cdk.Duration.hours(1),
      idTokenValidity: cdk.Duration.hours(1),
      refreshTokenValidity: cdk.Duration.days(7),
    });

    // Deployment workflow consumes these outputs to build the static admin application
    // with the exact Cognito identifiers belonging to the target environment.
    new cdk.CfnOutput(this, "UserPoolId", { value: this.userPool.userPoolId });
    new cdk.CfnOutput(this, "UserPoolClientId", { value: this.userPoolClient.userPoolClientId });
  }
}
