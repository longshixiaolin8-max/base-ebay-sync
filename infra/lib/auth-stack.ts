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
      // No self-signup: operator accounts are provisioned by an administrator only.
      selfSignUpEnabled: false,
      signInAliases: { email: true },
      standardAttributes: { email: { required: true, mutable: false } },
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
      // Threat Protection (the current name for what was "Advanced Security Features"),
      // prod only: per-MAU cost, so dev's handful of throwaway test accounts skip it.
      // FULL_FUNCTION actively blocks/challenges risky sign-ins (impossible travel,
      // compromised-credential lists) rather than only logging them.
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
  }
}
