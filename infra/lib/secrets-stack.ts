import * as cdk from "aws-cdk-lib";
import * as secretsmanager from "aws-cdk-lib/aws-secretsmanager";
import type { Construct } from "constructs";

export interface SecretsStackProps extends cdk.StackProps {
  envName: string;
}

/**
 * Provisions empty secret *containers* only. CDK never writes a real client id/secret
 * into these — that would mean the credential passes through a GitHub-triggered
 * pipeline and CloudFormation template diffs. A human fills in the real value after
 * deploy via `aws secretsmanager put-secret-value` or the console, satisfying both
 * "APIキーをGitHubへ保存しない" and "Secrets変更は人間承認必須".
 *
 * Names are scoped by envName for every env except "dev" (kept unprefixed for backward
 * compatibility -- dev's secrets already have real BASE/eBay/OpenAI credentials filled in
 * by hand; renaming them would silently break the one environment currently in live use).
 * dev and prod are meant to run side by side in the same AWS account (see
 * database-stack.ts/auth-stack.ts's own env-conditional settings), and Secrets Manager
 * names must be unique per account/region -- without this scoping, a prod deploy would
 * collide with dev's exact secret names and the two environments would end up reading/
 * writing each other's credentials and OAuth tokens.
 */
export class SecretsStack extends cdk.Stack {
  readonly baseAppCredentials: secretsmanager.Secret;
  readonly ebayAppCredentials: secretsmanager.Secret;
  readonly openAiApiKey: secretsmanager.Secret;
  readonly stripeAppCredentials: secretsmanager.Secret;
  readonly signupCredentials: secretsmanager.Secret;
  readonly oauthTokenPrefix: string;

  constructor(scope: Construct, id: string, props: SecretsStackProps) {
    super(scope, id, props);

    const envSegment = props.envName === "dev" ? "" : `${props.envName}/`;
    this.oauthTokenPrefix = `ai-ec-platform/${envSegment}oauth/`;

    this.baseAppCredentials = new secretsmanager.Secret(this, "BaseAppCredentials", {
      secretName: `ai-ec-platform/${envSegment}app-credentials/base`,
      description: "BASE OAuth app clientId/clientSecret. Fill in manually after deploy.",
    });

    this.ebayAppCredentials = new secretsmanager.Secret(this, "EbayAppCredentials", {
      secretName: `ai-ec-platform/${envSegment}app-credentials/ebay`,
      description:
        "eBay OAuth app clientId/clientSecret/ruName/merchantLocationKey. Fill in manually after deploy.",
    });

    this.openAiApiKey = new secretsmanager.Secret(this, "OpenAiApiKey", {
      secretName: `ai-ec-platform/${envSegment}app-credentials/openai`,
      description: "OpenAI API key, only used when AI_PROVIDER=openai. Fill in manually after deploy.",
    });

    // Phase 2 of the SaaS conversion ("self-service signup + Stripe test-mode billing").
    // { secretKey, publishableKey, priceId, webhookSigningSecret } -- test-mode only for
    // now, same manual-fill-in-after-deploy pattern as every other credential above.
    this.stripeAppCredentials = new secretsmanager.Secret(this, "StripeAppCredentials", {
      secretName: `ai-ec-platform/${envSegment}app-credentials/stripe`,
      description: "Stripe test-mode secretKey/publishableKey/priceId/webhookSigningSecret. Fill in manually after deploy.",
    });

    // { inviteCode } -- the one shared beta invite code /signup checks against. A single
    // shared string, not per-invitee tracking; revisit if that's ever needed.
    this.signupCredentials = new secretsmanager.Secret(this, "SignupCredentials", {
      secretName: `ai-ec-platform/${envSegment}app-credentials/signup`,
      description: "Shared invite code required by the public /signup flow. Fill in manually after deploy.",
    });
  }
}
