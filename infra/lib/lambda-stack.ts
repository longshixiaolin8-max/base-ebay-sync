import * as path from "node:path";
import { fileURLToPath } from "node:url";
import * as cdk from "aws-cdk-lib";
import * as events from "aws-cdk-lib/aws-events";
import * as targets from "aws-cdk-lib/aws-events-targets";
import * as iam from "aws-cdk-lib/aws-iam";
import * as lambda from "aws-cdk-lib/aws-lambda";
import { SqsEventSource } from "aws-cdk-lib/aws-lambda-event-sources";
import * as nodejs from "aws-cdk-lib/aws-lambda-nodejs";
import * as logs from "aws-cdk-lib/aws-logs";
import * as rds from "aws-cdk-lib/aws-rds";
import type * as s3 from "aws-cdk-lib/aws-s3";
import type * as secretsmanager from "aws-cdk-lib/aws-secretsmanager";
import type * as sqs from "aws-cdk-lib/aws-sqs";
import type { Construct } from "constructs";
import type { PlatformConfig } from "./config.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.join(__dirname, "..", "..");
const LOCK_FILE = path.join(REPO_ROOT, "pnpm-lock.yaml");

export interface LambdaStackProps extends cdk.StackProps {
  config: PlatformConfig;
  cluster: rds.DatabaseCluster;
  databaseName: string;
  appCredentialSecrets: {
    base: secretsmanager.Secret;
    ebay: secretsmanager.Secret;
    openai: secretsmanager.Secret;
  };
  oauthTokenSecretArnPattern: string;
  apiUrl: string;
  queues: {
    aiGenerate: sqs.Queue;
    ebaySync: sqs.Queue;
    inventorySync: sqs.Queue;
  };
  dlqs: {
    aiGenerate: sqs.Queue;
    ebaySync: sqs.Queue;
    inventorySync: sqs.Queue;
  };
  productImagesBucket: s3.Bucket;
}

/** Standard ESM bundling: esbuild's ESM output needs `require` shimmed for CJS deps. */
const ESM_BUNDLING: Partial<nodejs.BundlingOptions> = {
  format: nodejs.OutputFormat.ESM,
  target: "node22",
  banner: "import { createRequire } from 'module'; const require = createRequire(import.meta.url);",
  mainFields: ["module", "main"],
};

export class LambdaStack extends cdk.Stack {
  readonly adminApiFn: nodejs.NodejsFunction;
  readonly oauthBaseAuthorizeFn: nodejs.NodejsFunction;
  readonly oauthBaseCallbackFn: nodejs.NodejsFunction;
  readonly oauthEbayAuthorizeFn: nodejs.NodejsFunction;
  readonly oauthEbayCallbackFn: nodejs.NodejsFunction;
  readonly ebayWebhookFn: nodejs.NodejsFunction;
  readonly productFetchFn: nodejs.NodejsFunction;
  readonly aiGenerateWorkerFn: nodejs.NodejsFunction;
  readonly ebaySyncWorkerFn: nodejs.NodejsFunction;
  readonly salesPollerFn: nodejs.NodejsFunction;
  readonly inventorySyncWorkerFn: nodejs.NodejsFunction;
  readonly inventoryDiffCheckFn: nodejs.NodejsFunction;
  readonly dlqRedriveFn: nodejs.NodejsFunction;

  constructor(scope: Construct, id: string, props: LambdaStackProps) {
    super(scope, id, props);

    const commonEnv: Record<string, string> = {
      DB_CLUSTER_ARN: props.cluster.clusterArn,
      DB_SECRET_ARN: props.cluster.secret!.secretArn,
      DB_NAME: props.databaseName,
      AI_GENERATE_QUEUE_URL: props.queues.aiGenerate.queueUrl,
      EBAY_SYNC_QUEUE_URL: props.queues.ebaySync.queueUrl,
      INVENTORY_SYNC_QUEUE_URL: props.queues.inventorySync.queueUrl,
      AI_PROVIDER: props.config.aiProvider,
    };

    const oauthTokenSecretsPolicy = new iam.PolicyStatement({
      actions: ["secretsmanager:GetSecretValue", "secretsmanager:PutSecretValue", "secretsmanager:CreateSecret", "secretsmanager:DescribeSecret"],
      resources: [props.oauthTokenSecretArnPattern],
    });

    const makeFn = (
      id: string,
      entry: string,
      handlerName: string,
      extraEnv: Record<string, string> = {},
      timeout = cdk.Duration.seconds(30),
    ): nodejs.NodejsFunction => {
      const fn = new nodejs.NodejsFunction(this, id, {
        entry: path.join(REPO_ROOT, entry),
        handler: handlerName,
        runtime: lambda.Runtime.NODEJS_22_X,
        architecture: lambda.Architecture.ARM_64,
        memorySize: 512,
        timeout,
        depsLockFilePath: LOCK_FILE,
        logRetention: logs.RetentionDays.ONE_MONTH,
        environment: { ...commonEnv, ...extraEnv },
        bundling: ESM_BUNDLING,
      });

      props.cluster.grantDataApiAccess(fn);
      fn.addToRolePolicy(oauthTokenSecretsPolicy);
      return fn;
    };

    // --- OAuth ---
    this.oauthBaseAuthorizeFn = makeFn(
      "OauthBaseAuthorize",
      "services/lambdas/oauth-base/src/handler.ts",
      "authorize",
      { BASE_OAUTH_REDIRECT_URI: `${props.apiUrl}/oauth/base/callback` },
    );
    this.oauthBaseCallbackFn = makeFn(
      "OauthBaseCallback",
      "services/lambdas/oauth-base/src/handler.ts",
      "callback",
      { BASE_OAUTH_REDIRECT_URI: `${props.apiUrl}/oauth/base/callback` },
    );
    this.oauthEbayAuthorizeFn = makeFn("OauthEbayAuthorize", "services/lambdas/oauth-ebay/src/handler.ts", "authorize");
    this.oauthEbayCallbackFn = makeFn("OauthEbayCallback", "services/lambdas/oauth-ebay/src/handler.ts", "callback");
    for (const fn of [this.oauthBaseAuthorizeFn, this.oauthBaseCallbackFn]) {
      props.appCredentialSecrets.base.grantRead(fn);
    }
    for (const fn of [this.oauthEbayAuthorizeFn, this.oauthEbayCallbackFn]) {
      props.appCredentialSecrets.ebay.grantRead(fn);
    }

    this.ebayWebhookFn = makeFn(
      "EbayWebhook",
      "services/lambdas/ebay-webhook/src/handler.ts",
      "handler",
      { EBAY_WEBHOOK_ENDPOINT_URL: `${props.apiUrl}/webhooks/ebay/notifications` },
      cdk.Duration.minutes(2),
    );
    props.appCredentialSecrets.ebay.grantRead(this.ebayWebhookFn);
    props.queues.inventorySync.grantSendMessages(this.ebayWebhookFn);

    // --- Product / AI / eBay sync pipeline ---
    this.productFetchFn = makeFn(
      "ProductFetch",
      "services/lambdas/product-fetch/src/handler.ts",
      "handler",
      {},
      cdk.Duration.minutes(5),
    );
    props.appCredentialSecrets.base.grantRead(this.productFetchFn);
    props.queues.aiGenerate.grantSendMessages(this.productFetchFn);
    props.queues.ebaySync.grantSendMessages(this.productFetchFn);
    new events.Rule(this, "ProductFetchSchedule", {
      schedule: events.Schedule.rate(cdk.Duration.minutes(15)),
      targets: [new targets.LambdaFunction(this.productFetchFn)],
    });

    this.aiGenerateWorkerFn = makeFn(
      "AiGenerateWorker",
      "services/lambdas/ai-generate-worker/src/handler.ts",
      "handler",
      props.config.aiProvider === "openai" ? {} : {},
      cdk.Duration.minutes(2),
    );
    if (props.config.aiProvider === "openai") {
      props.appCredentialSecrets.openai.grantRead(this.aiGenerateWorkerFn);
    } else {
      this.aiGenerateWorkerFn.addToRolePolicy(
        new iam.PolicyStatement({
          actions: ["bedrock:InvokeModel"],
          resources: ["*"], // Bedrock model invocation is not resource-scopable below the model-ARN level; restrict via SCP/model access controls at the account level.
        }),
      );
    }
    this.aiGenerateWorkerFn.addEventSource(
      new SqsEventSource(props.queues.aiGenerate, { batchSize: 5, reportBatchItemFailures: true }),
    );

    this.ebaySyncWorkerFn = makeFn(
      "EbaySyncWorker",
      "services/lambdas/ebay-sync-worker/src/handler.ts",
      "handler",
      {},
      cdk.Duration.minutes(2),
    );
    props.appCredentialSecrets.ebay.grantRead(this.ebaySyncWorkerFn);
    this.ebaySyncWorkerFn.addEventSource(
      new SqsEventSource(props.queues.ebaySync, { batchSize: 5, reportBatchItemFailures: true }),
    );

    // --- Inventory sync (double-sell prevention) ---
    this.salesPollerFn = makeFn(
      "SalesPoller",
      "services/lambdas/sales-poller/src/handler.ts",
      "handler",
      {},
      cdk.Duration.minutes(2),
    );
    props.appCredentialSecrets.base.grantRead(this.salesPollerFn);
    props.appCredentialSecrets.ebay.grantRead(this.salesPollerFn);
    props.queues.inventorySync.grantSendMessages(this.salesPollerFn);
    new events.Rule(this, "SalesPollerSchedule", {
      // 1 minute is EventBridge's finest rate() granularity. Shortened from 5 minutes as the
      // practical near-real-time substitute for eBay's LISTING webhook, whose required
      // sell.listing[.read] scope this app's Sandbox keyset does not currently have access to.
      schedule: events.Schedule.rate(cdk.Duration.minutes(1)),
      targets: [new targets.LambdaFunction(this.salesPollerFn)],
    });

    this.inventorySyncWorkerFn = makeFn(
      "InventorySyncWorker",
      "services/lambdas/inventory-sync-worker/src/handler.ts",
      "handler",
      {},
      cdk.Duration.minutes(2),
    );
    props.appCredentialSecrets.base.grantRead(this.inventorySyncWorkerFn);
    props.appCredentialSecrets.ebay.grantRead(this.inventorySyncWorkerFn);
    this.inventorySyncWorkerFn.addEventSource(
      new SqsEventSource(props.queues.inventorySync, { batchSize: 1, reportBatchItemFailures: true }),
    );

    this.inventoryDiffCheckFn = makeFn(
      "InventoryDiffCheck",
      "services/lambdas/inventory-diff-check/src/handler.ts",
      "handler",
      {},
      cdk.Duration.minutes(5),
    );
    props.appCredentialSecrets.base.grantRead(this.inventoryDiffCheckFn);
    props.appCredentialSecrets.ebay.grantRead(this.inventoryDiffCheckFn);
    new events.Rule(this, "InventoryDiffCheckSchedule", {
      schedule: events.Schedule.rate(cdk.Duration.hours(6)),
      targets: [new targets.LambdaFunction(this.inventoryDiffCheckFn)],
    });

    // --- Automatic recovery after API failures (item #4) ---
    this.dlqRedriveFn = makeFn(
      "DlqRedrive",
      "services/lambdas/dlq-redrive/src/handler.ts",
      "handler",
      {
        AI_GENERATE_DLQ_URL: props.dlqs.aiGenerate.queueUrl,
        AI_GENERATE_DLQ_ARN: props.dlqs.aiGenerate.queueArn,
        EBAY_SYNC_DLQ_URL: props.dlqs.ebaySync.queueUrl,
        EBAY_SYNC_DLQ_ARN: props.dlqs.ebaySync.queueArn,
        INVENTORY_SYNC_DLQ_URL: props.dlqs.inventorySync.queueUrl,
        INVENTORY_SYNC_DLQ_ARN: props.dlqs.inventorySync.queueArn,
      },
      cdk.Duration.seconds(30),
    );
    // StartMessageMoveTask runs as an AWS-managed receive-from-DLQ / send-to-original-queue
    // loop under the hood, so the caller's IAM identity needs permissions on both ends, not
    // just the move-task control-plane actions on the DLQ.
    for (const dlq of [props.dlqs.aiGenerate, props.dlqs.ebaySync, props.dlqs.inventorySync]) {
      dlq.grant(
        this.dlqRedriveFn,
        "sqs:GetQueueAttributes",
        "sqs:ListMessageMoveTasks",
        "sqs:StartMessageMoveTask",
        "sqs:ReceiveMessage",
        "sqs:DeleteMessage",
      );
    }
    for (const queue of [props.queues.aiGenerate, props.queues.ebaySync, props.queues.inventorySync]) {
      queue.grant(this.dlqRedriveFn, "sqs:SendMessage");
    }
    new events.Rule(this, "DlqRedriveSchedule", {
      schedule: events.Schedule.rate(cdk.Duration.minutes(30)),
      targets: [new targets.LambdaFunction(this.dlqRedriveFn)],
    });

    // --- Admin API ---
    this.adminApiFn = makeFn(
      "AdminApi",
      "services/lambdas/admin-api/src/handler.ts",
      "handler",
      { EBAY_WEBHOOK_ENDPOINT_URL: `${props.apiUrl}/webhooks/ebay/notifications` },
      // POST /admin/ebay/webhook-setup blocks on eBay's real challenge-code round trip to
      // our own endpoint during destination creation, so this needs more than the old 15s.
      cdk.Duration.seconds(30),
    );
    props.queues.aiGenerate.grantSendMessages(this.adminApiFn);
    props.queues.ebaySync.grantSendMessages(this.adminApiFn);
    props.queues.inventorySync.grantSendMessages(this.adminApiFn);
    // Needed for POST /admin/ebay/location, which reads eBay app credentials and the
    // connected account's OAuth token (already granted to every fn via makeFn) to create
    // the seller's ship-from location.
    props.appCredentialSecrets.ebay.grantRead(this.adminApiFn);

    // productImagesBucket is provisioned for a future image re-hosting step (see README
    // follow-ups); no lambda writes to it yet, so no grant is issued until one does.
    void props.productImagesBucket;
  }
}
