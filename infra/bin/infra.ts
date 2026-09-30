#!/usr/bin/env node
import "source-map-support/register.js";
import * as cdk from "aws-cdk-lib";
import { AdminHostingStack } from "../lib/admin-hosting-stack.js";
import { ApiCoreStack } from "../lib/api-core-stack.js";
import { ApiStack } from "../lib/api-stack.js";
import { AuthStack } from "../lib/auth-stack.js";
import { CloudFrontStack } from "../lib/cloudfront-stack.js";
import { DatabaseStack } from "../lib/database-stack.js";
import { loadConfig } from "../lib/config.js";
import { GithubOidcStack } from "../lib/github-oidc-stack.js";
import { LambdaStack } from "../lib/lambda-stack.js";
import { MonitoringStack } from "../lib/monitoring-stack.js";
import { QueueStack } from "../lib/queue-stack.js";
import { SecretsStack } from "../lib/secrets-stack.js";
import { StorageStack } from "../lib/storage-stack.js";
import { WafStack } from "../lib/waf-stack.js";

const app = new cdk.App();

const envName = (app.node.tryGetContext("env") as string | undefined) ?? "dev";
const alarmEmail = app.node.tryGetContext("alarmEmail") as string | undefined;
const aiProvider = app.node.tryGetContext("aiProvider") as string | undefined;
const githubRepo = (app.node.tryGetContext("githubRepo") as string | undefined) ?? "OWNER/base-ebay-sync";
const monthlyBudgetUsd = app.node.tryGetContext("monthlyBudgetUsd") as string | undefined;
// "direct" (default, unchanged) or "cloudfront" -- see PlatformConfig.apiEntrypoint's own
// doc comment and README's runbook before ever passing --context apiEntrypoint=cloudfront.
const apiEntrypoint = app.node.tryGetContext("apiEntrypoint") as string | undefined;
// See PlatformConfig.ebayPlatformNotificationThrottleEnabled's own doc comment: leave this
// false on the first deploy that ever introduces the platform-notifications route in a given
// environment (it fails otherwise -- the Route doesn't exist yet for the Stage to reference),
// then pass `--context ebayPlatformNotificationThrottleEnabled=true` on a later deploy once
// that first one has succeeded.
const ebayPlatformNotificationThrottleEnabled = app.node.tryGetContext("ebayPlatformNotificationThrottleEnabled") as
  | string
  | undefined;
// See PlatformConfig.sesFromEmail's own doc comment: unset by default (billing-notice emails
// stay a caught, logged no-op) until an address/domain has been verified in the SES console
// for this account/region and passed here via `--context sesFromEmail=notifications@yourdomain`.
const sesFromEmail = app.node.tryGetContext("sesFromEmail") as string | undefined;

const config = loadConfig(
  envName,
  alarmEmail,
  aiProvider,
  monthlyBudgetUsd,
  apiEntrypoint,
  ebayPlatformNotificationThrottleEnabled,
  sesFromEmail,
);

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
const secrets = new SecretsStack(app, `${stackPrefix}-Secrets`, { env, tags, envName });
const storage = new StorageStack(app, `${stackPrefix}-Storage`, config, { env, tags });
const auth = new AuthStack(app, `${stackPrefix}-Auth`, config, { env, tags });
const queues = new QueueStack(app, `${stackPrefix}-Queues`, { env, tags });
// Created before ApiCoreStack so its real hosted origin (a stable *.amplifyapp.com URL,
// independent of anything ApiCoreStack/LambdaStack/ApiStack produce) can tighten the API's
// CORS config away from the wildcard bootstrap fallback -- see api-core-stack.ts.
const adminHosting = new AdminHostingStack(app, `${stackPrefix}-AdminHosting`, { env, tags, envName });
const apiCore = new ApiCoreStack(app, `${stackPrefix}-ApiCore`, { env, tags, adminOrigin: adminHosting.url });

// WAF-protected CloudFront entry point in front of apiCore.api -- created before LambdaStack
// (unlike the rest of this file's original ordering) because computing apiUrl below needs
// its auto-generated domain name, which only exists once the distribution itself does.
// Standing this up is still purely additive: config.apiEntrypoint (default "direct") is
// what actually decides whether anything downstream (BASE_OAUTH_REDIRECT_URI, the eBay
// webhook destinations, CLOUDFRONT_SHARED_SECRET) ever uses it -- see cloudfront-stack.ts
// and config.ts's own doc comments, and README's runbook for the real cutover.
const waf = new WafStack(app, `${stackPrefix}-Waf`, {
  env: { account: env.account, region: "us-east-1" }, // WAFv2's CLOUDFRONT scope is us-east-1-only
  tags,
  crossRegionReferences: true,
});
const cloudfrontApi = new CloudFrontStack(app, `${stackPrefix}-CloudFrontApi`, {
  env,
  tags,
  crossRegionReferences: true,
  api: apiCore.api,
  webAclArn: waf.webAcl.attrArn,
  sharedSecret: secrets.cloudfrontSharedSecret,
});
cloudfrontApi.addStackDependency(apiCore);
cloudfrontApi.addStackDependency(waf);
cloudfrontApi.addStackDependency(secrets);

const apiUrl = config.apiEntrypoint === "cloudfront" ? `https://${cloudfrontApi.distribution.domainName}` : apiCore.api.apiEndpoint;

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
    stripe: secrets.stripeAppCredentials,
    signup: secrets.signupCredentials,
  },
  oauthTokenSecretArnPattern: `arn:aws:secretsmanager:${env.region}:${env.account}:secret:${secrets.oauthTokenPrefix}*`,
  apiUrl,
  adminAppUrl: adminHosting.url,
  cloudFrontSharedSecret: secrets.cloudfrontSharedSecret,
  userPoolArn: auth.userPool.userPoolArn,
  userPoolId: auth.userPool.userPoolId,
  queues: {
    aiGenerate: queues.aiGenerate.queue,
    ebaySync: queues.ebaySync.queue,
    inventorySync: queues.inventorySync.queue,
    ebayPlatformNotificationPoll: queues.ebayPlatformNotificationPoll.queue,
  },
  dlqs: {
    aiGenerate: queues.aiGenerate.dlq,
    ebaySync: queues.ebaySync.dlq,
    inventorySync: queues.inventorySync.dlq,
    ebayPlatformNotificationPoll: queues.ebayPlatformNotificationPoll.dlq,
  },
  productImagesBucket: storage.productImagesBucket,
});
lambdas.addStackDependency(database);
lambdas.addStackDependency(secrets);
lambdas.addStackDependency(queues);
lambdas.addStackDependency(storage);
lambdas.addStackDependency(apiCore);
lambdas.addStackDependency(auth);
lambdas.addStackDependency(cloudfrontApi); // apiUrl may reference its domain name (config.apiEntrypoint === "cloudfront")

const api = new ApiStack(app, `${stackPrefix}-Api`, {
  env,
  tags,
  api: apiCore.api,
  userPool: auth.userPool,
  userPoolClient: auth.userPoolClient,
  adminApiFn: lambdas.adminApiFn,
  oauthBaseCallbackFn: lambdas.oauthBaseCallbackFn,
  oauthEbayCallbackFn: lambdas.oauthEbayCallbackFn,
  ebayWebhookFn: lambdas.ebayWebhookFn,
  signupHandlerFn: lambdas.signupHandlerFn,
  stripeWebhookFn: lambdas.stripeWebhookFn,
  enableEbayPlatformNotificationThrottle: config.ebayPlatformNotificationThrottleEnabled,
});
api.addStackDependency(lambdas);
api.addStackDependency(auth);
api.addStackDependency(apiCore);

new MonitoringStack(app, `${stackPrefix}-Monitoring`, {
  env,
  tags,
  config,
  dlqs: [queues.aiGenerate.dlq, queues.ebaySync.dlq, queues.inventorySync.dlq, queues.ebayPlatformNotificationPoll.dlq],
  workerFns: [
    lambdas.adminApiFn,
    lambdas.productFetchFn,
    lambdas.aiGenerateWorkerFn,
    lambdas.ebaySyncWorkerFn,
    lambdas.salesPollerFn,
    lambdas.inventorySyncWorkerFn,
    lambdas.inventoryDiffCheckFn,
    lambdas.tenantOffboardingFn,
    lambdas.ebayPlatformNotificationDispatcherFn,
  ],
  // Must match exactly the functions makeFn gave a reservedConcurrency cap to (lambda-stack.ts).
  concurrencyCappedFns: [
    lambdas.aiGenerateWorkerFn,
    lambdas.ebaySyncWorkerFn,
    lambdas.inventorySyncWorkerFn,
    lambdas.ebayPlatformNotificationDispatcherFn,
  ],
});
