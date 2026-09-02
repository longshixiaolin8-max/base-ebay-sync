#!/usr/bin/env node
import "source-map-support/register.js";
import * as cdk from "aws-cdk-lib";
import { ApiCoreStack } from "../lib/api-core-stack.js";
import { ApiStack } from "../lib/api-stack.js";
import { AuthStack } from "../lib/auth-stack.js";
import { DatabaseStack } from "../lib/database-stack.js";
import { loadConfig } from "../lib/config.js";
import { GithubOidcStack } from "../lib/github-oidc-stack.js";
import { LambdaStack } from "../lib/lambda-stack.js";
import { MonitoringStack } from "../lib/monitoring-stack.js";
import { QueueStack } from "../lib/queue-stack.js";
import { SecretsStack } from "../lib/secrets-stack.js";
import { StorageStack } from "../lib/storage-stack.js";

const app = new cdk.App();

const envName = (app.node.tryGetContext("env") as string | undefined) ?? "dev";
const alarmEmail = app.node.tryGetContext("alarmEmail") as string | undefined;
const aiProvider = app.node.tryGetContext("aiProvider") as string | undefined;
const githubRepo = (app.node.tryGetContext("githubRepo") as string | undefined) ?? "OWNER/base-ebay-sync";

const config = loadConfig(envName, alarmEmail, aiProvider);

// Region is read from CDK context (`--context region=...`), not from
// CDK_DEFAULT_REGION/AWS_REGION — the CDK CLI recomputes those env vars from the
// ambient AWS SDK default-region chain and overwrites whatever the shell exported
// before spawning this app, so relying on them here made the deploy region silently
// drift to whatever (or nothing) the CLI's environment happened to resolve. Explicit
// context keeps `cdk synth` deterministic and usable in CI with no AWS credentials.
const region = (app.node.tryGetContext("region") as string | undefined) ?? "us-east-2";
const env: cdk.Environment = {
  account: process.env.CDK_DEFAULT_ACCOUNT,
  region,
};

const stackPrefix = `AiEcPlatform-${envName}`;
const tags = { project: "ai-ec-platform", environment: envName };

// One-time human-run bootstrap (see infra/lib/github-oidc-stack.ts): NOT part of the
// automated GitHub Actions deploy (that workflow assumes the role this stack creates,
// so it can't be the one to create it). Deploy it once, locally, with your own AWS
// credentials: `cdk deploy <stackPrefix>-GithubOidc --context bootstrapOidc=true`.
if (app.node.tryGetContext("bootstrapOidc") === "true") {
  new GithubOidcStack(app, `${stackPrefix}-GithubOidc`, { githubRepo }, { env, tags });
}

const database = new DatabaseStack(app, `${stackPrefix}-Database`, config, { env, tags });
const secrets = new SecretsStack(app, `${stackPrefix}-Secrets`, { env, tags });
const storage = new StorageStack(app, `${stackPrefix}-Storage`, config, { env, tags });
const auth = new AuthStack(app, `${stackPrefix}-Auth`, config, { env, tags });
const queues = new QueueStack(app, `${stackPrefix}-Queues`, { env, tags });
const apiCore = new ApiCoreStack(app, `${stackPrefix}-ApiCore`, { env, tags });

const lambdas = new LambdaStack(app, `${stackPrefix}-Lambdas`, {
  env,
  tags,
  config,
  cluster: database.cluster,
  databaseName: database.databaseName,
  appCredentialSecrets: {
    base: secrets.baseAppCredentials,
    ebay: secrets.ebayAppCredentials,
    openai: secrets.openAiApiKey,
  },
  oauthTokenSecretArnPattern: `arn:aws:secretsmanager:${env.region}:${env.account}:secret:${secrets.oauthTokenPrefix}*`,
  apiUrl: apiCore.api.apiEndpoint,
  queues: { aiGenerate: queues.aiGenerate.queue, ebaySync: queues.ebaySync.queue, inventorySync: queues.inventorySync.queue },
  productImagesBucket: storage.productImagesBucket,
});
lambdas.addStackDependency(database);
lambdas.addStackDependency(secrets);
lambdas.addStackDependency(queues);
lambdas.addStackDependency(storage);
lambdas.addStackDependency(apiCore);

const api = new ApiStack(app, `${stackPrefix}-Api`, {
  env,
  tags,
  api: apiCore.api,
  userPool: auth.userPool,
  userPoolClient: auth.userPoolClient,
  adminApiFn: lambdas.adminApiFn,
  oauthBaseAuthorizeFn: lambdas.oauthBaseAuthorizeFn,
  oauthBaseCallbackFn: lambdas.oauthBaseCallbackFn,
  oauthEbayAuthorizeFn: lambdas.oauthEbayAuthorizeFn,
  oauthEbayCallbackFn: lambdas.oauthEbayCallbackFn,
  ebayWebhookFn: lambdas.ebayWebhookFn,
});
api.addStackDependency(lambdas);
api.addStackDependency(auth);
api.addStackDependency(apiCore);

new MonitoringStack(app, `${stackPrefix}-Monitoring`, {
  env,
  tags,
  config,
  dlqs: [queues.aiGenerate.dlq, queues.ebaySync.dlq, queues.inventorySync.dlq],
  workerFns: [
    lambdas.adminApiFn,
    lambdas.productFetchFn,
    lambdas.aiGenerateWorkerFn,
    lambdas.ebaySyncWorkerFn,
    lambdas.salesPollerFn,
    lambdas.inventorySyncWorkerFn,
    lambdas.inventoryDiffCheckFn,
  ],
});
