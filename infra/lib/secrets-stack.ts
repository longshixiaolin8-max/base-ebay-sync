import * as cdk from "aws-cdk-lib";
import * as secretsmanager from "aws-cdk-lib/aws-secretsmanager";
import type { Construct } from "constructs";

/**
 * Provisions empty secret *containers* only. CDK never writes a real client id/secret
 * into these — that would mean the credential passes through a GitHub-triggered
 * pipeline and CloudFormation template diffs. A human fills in the real value after
 * deploy via `aws secretsmanager put-secret-value` or the console, satisfying both
 * "APIキーをGitHubへ保存しない" and "Secrets変更は人間承認必須".
 */
export class SecretsStack extends cdk.Stack {
  readonly baseAppCredentials: secretsmanager.Secret;
  readonly ebayAppCredentials: secretsmanager.Secret;
  readonly openAiApiKey: secretsmanager.Secret;
  readonly oauthTokenPrefix = "ai-ec-platform/oauth/";

  constructor(scope: Construct, id: string, props?: cdk.StackProps) {
    super(scope, id, props);

    this.baseAppCredentials = new secretsmanager.Secret(this, "BaseAppCredentials", {
      secretName: "ai-ec-platform/app-credentials/base",
      description: "BASE OAuth app clientId/clientSecret. Fill in manually after deploy.",
    });

    this.ebayAppCredentials = new secretsmanager.Secret(this, "EbayAppCredentials", {
      secretName: "ai-ec-platform/app-credentials/ebay",
      description:
        "eBay OAuth app clientId/clientSecret/ruName/merchantLocationKey. Fill in manually after deploy.",
    });

    this.openAiApiKey = new secretsmanager.Secret(this, "OpenAiApiKey", {
      secretName: "ai-ec-platform/app-credentials/openai",
      description: "OpenAI API key, only used when AI_PROVIDER=openai. Fill in manually after deploy.",
    });
  }
}
