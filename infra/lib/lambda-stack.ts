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
    stripe: secretsmanager.Secret;
    signup: secretsmanager.Secret;
  };
  oauthTokenSecretArnPattern: string;
  apiUrl: string;
  adminAppUrl: string;
  /** Scoped IAM resource for the signup Lambda's AdminCreateUser/AdminSetUserPassword grant --
   *  narrower than a wildcard, matching this stack's existing scoped-secret-ARN pattern. */
  userPoolArn: string;
  userPoolId: string;
  queues: {
    aiGenerate: sqs.Queue;
    ebaySync: sqs.Queue;
    inventorySync: sqs.Queue;
    ebayPlatformNotificationPoll: sqs.Queue;
  };
  dlqs: {
    aiGenerate: sqs.Queue;
    ebaySync: sqs.Queue;
    inventorySync: sqs.Queue;
    ebayPlatformNotificationPoll: sqs.Queue;
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
  readonly oauthBaseCallbackFn: nodejs.NodejsFunction;
  readonly oauthEbayCallbackFn: nodejs.NodejsFunction;
  readonly ebayWebhookFn: nodejs.NodejsFunction;
  readonly ebayPlatformNotificationDispatcherFn: nodejs.NodejsFunction;
  readonly productFetchFn: nodejs.NodejsFunction;
  readonly aiGenerateWorkerFn: nodejs.NodejsFunction;
  readonly ebaySyncWorkerFn: nodejs.NodejsFunction;
  readonly salesPollerFn: nodejs.NodejsFunction;
  readonly inventorySyncWorkerFn: nodejs.NodejsFunction;
  readonly inventoryDiffCheckFn: nodejs.NodejsFunction;
  readonly tenantOffboardingFn: nodejs.NodejsFunction;
  readonly dlqRedriveFn: nodejs.NodejsFunction;
  readonly signupHandlerFn: nodejs.NodejsFunction;
  readonly stripeWebhookFn: nodejs.NodejsFunction;
  readonly dbMigrateFn: nodejs.NodejsFunction;

  constructor(scope: Construct, id: string, props: LambdaStackProps) {
    super(scope, id, props);

    const commonEnv: Record<string, string> = {
      DB_CLUSTER_ARN: props.cluster.clusterArn,
      DB_SECRET_ARN: props.cluster.secret!.secretArn,
      DB_NAME: props.databaseName,
      AI_GENERATE_QUEUE_URL: props.queues.aiGenerate.queueUrl,
      EBAY_SYNC_QUEUE_URL: props.queues.ebaySync.queueUrl,
      INVENTORY_SYNC_QUEUE_URL: props.queues.inventorySync.queueUrl,
      EBAY_PLATFORM_NOTIFICATION_POLL_QUEUE_URL: props.queues.ebayPlatformNotificationPoll.queueUrl,
      AI_PROVIDER: props.config.aiProvider,
      // Read by @ai-ec/lambda-shared's secrets.ts to build env-scoped Secrets Manager
      // names (see secrets-stack.ts) so dev and prod, run side by side in the same
      // account, never read/write each other's app credentials or OAuth tokens.
      PLATFORM_ENV: props.config.envName,
    };

    const oauthTokenSecretsPolicy = new iam.PolicyStatement({
      // DeleteSecret is needed by tenant-offboarding's own OAuth-revoke step (see
      // deleteOAuthConnectionsForTenant) and by ebay-webhook's Marketplace Account
      // Deletion handler (deleteOAuthConnectionsByExternalAccount) -- both call
      // DeleteSecretCommand against a token secret under this same prefix. Granted on the
      // same shared, already-broad (every makeFn'd lambda gets read+write on every tenant's
      // OAuth token secret) statement rather than a narrower per-lambda one, matching this
      // policy's existing precedent rather than introducing a new grant shape for it.
      actions: [
        "secretsmanager:GetSecretValue",
        "secretsmanager:PutSecretValue",
        "secretsmanager:CreateSecret",
        "secretsmanager:DescribeSecret",
        "secretsmanager:DeleteSecret",
      ],
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
    // Round 12 hardening ("public OAuth authorize routeを廃止"): only /callback is public
    // now (BASE/eBay's own redirect target, which never carries a Cognito session either --
    // protected by verifyState's signed, tenant-bound, time-limited state instead). The
    // /authorize step itself moved entirely to admin-api's authenticated
    // GET /admin/oauth/{base,ebay}/authorize-url, which mints that same signed state from
    // *this caller's own* tenantId -- so there's no longer a separate Authorize Lambda/route
    // for either channel.
    this.oauthBaseCallbackFn = makeFn(
      "OauthBaseCallback",
      "services/lambdas/oauth-base/src/handler.ts",
      "callback",
      { BASE_OAUTH_REDIRECT_URI: `${props.apiUrl}/oauth/base/callback` },
    );
    this.oauthEbayCallbackFn = makeFn("OauthEbayCallback", "services/lambdas/oauth-ebay/src/handler.ts", "callback");
    props.appCredentialSecrets.base.grantRead(this.oauthBaseCallbackFn);
    props.appCredentialSecrets.ebay.grantRead(this.oauthEbayCallbackFn);

    this.ebayWebhookFn = makeFn(
      "EbayWebhook",
      "services/lambdas/ebay-webhook/src/handler.ts",
      "handler",
      { EBAY_WEBHOOK_ENDPOINT_URL: `${props.apiUrl}/webhooks/ebay/notifications` },
      cdk.Duration.minutes(2),
    );
    props.appCredentialSecrets.ebay.grantRead(this.ebayWebhookFn);
    props.queues.inventorySync.grantSendMessages(this.ebayWebhookFn);
    props.queues.ebayPlatformNotificationPoll.grantSendMessages(this.ebayWebhookFn);

    // Round 14 hardening ("eBay Platform Notification abuse対策"): the actual eBay poll a
    // platform-notification triggers now runs here, off the public webhook's own request
    // path -- see ebay-webhook's own handlePlatformNotification/triggerCoalescedPoll
    // comments for why (a flood of HTTP requests can amplify at most into this queue's
    // depth, never into synchronous eBay API calls). Deployed from the same handler.ts as
    // EbayWebhook above, just a different exported entrypoint -- same pattern as
    // oauth-{base,ebay}'s authorize/callback split before it.
    this.ebayPlatformNotificationDispatcherFn = makeFn(
      "EbayPlatformNotificationDispatcher",
      "services/lambdas/ebay-webhook/src/handler.ts",
      "dispatchPoll",
      {},
      cdk.Duration.minutes(2),
    );
    props.appCredentialSecrets.ebay.grantRead(this.ebayPlatformNotificationDispatcherFn);
    props.queues.inventorySync.grantSendMessages(this.ebayPlatformNotificationDispatcherFn);
    this.ebayPlatformNotificationDispatcherFn.addEventSource(
      new SqsEventSource(props.queues.ebayPlatformNotificationPoll, { batchSize: 5, reportBatchItemFailures: true }),
    );

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
    // Needed for the AI mis-listing gate (item #5): when a product's content has changed
    // since its AI draft was generated, publish()/update() enqueue a fresh ai_generate job
    // instead of pushing a possibly-stale listing.
    props.queues.aiGenerate.grantSendMessages(this.ebaySyncWorkerFn);

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

    // Tenant lifecycle (round 11 hardening, "解約済みテナントのworker動作を修正"): delists a
    // canceled/canceling tenant's still-published listings on both marketplaces, then
    // revokes this platform's own OAuth connections for it once every one is confirmed
    // delisted. Runs independently of, and less often than, the routine sync workers above
    // -- offboarding has no latency requirement, and listWorkerEligibleTenants already keeps
    // a canceling tenant's *existing* listings safely synced in the meantime.
    this.tenantOffboardingFn = makeFn(
      "TenantOffboarding",
      "services/lambdas/tenant-offboarding/src/handler.ts",
      "handler",
      {},
      cdk.Duration.minutes(5),
    );
    props.appCredentialSecrets.base.grantRead(this.tenantOffboardingFn);
    props.appCredentialSecrets.ebay.grantRead(this.tenantOffboardingFn);
    new events.Rule(this, "TenantOffboardingSchedule", {
      schedule: events.Schedule.rate(cdk.Duration.hours(1)),
      targets: [new targets.LambdaFunction(this.tenantOffboardingFn)],
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

    // --- Phase 2 of the SaaS conversion ("self-service signup + Stripe test-mode billing") ---
    this.signupHandlerFn = makeFn(
      "SignupHandler",
      "services/lambdas/signup/src/handler.ts",
      "handler",
      { COGNITO_USER_POOL_ID: props.userPoolId, ADMIN_APP_URL: props.adminAppUrl },
      cdk.Duration.seconds(30),
    );
    props.appCredentialSecrets.stripe.grantRead(this.signupHandlerFn);
    props.appCredentialSecrets.signup.grantRead(this.signupHandlerFn);
    this.signupHandlerFn.addToRolePolicy(
      new iam.PolicyStatement({
        actions: ["cognito-idp:AdminCreateUser", "cognito-idp:AdminSetUserPassword"],
        resources: [props.userPoolArn],
      }),
    );

    this.stripeWebhookFn = makeFn(
      "StripeWebhook",
      "services/lambdas/stripe-webhook/src/handler.ts",
      "handler",
      {},
      cdk.Duration.seconds(30),
    );
    props.appCredentialSecrets.stripe.grantRead(this.stripeWebhookFn);

    // --- Database migrations ---
    // No environment has ever had a script or CI step that actually applies
    // packages/db/migrations/*.sql -- every one so far was run by hand from a session that
    // happened to have direct database access. Meant to be invoked manually (AWS Console
    // "Test", or `aws lambda invoke`) once per fresh environment and again whenever new
    // migrations are added; drizzle's own migrator tracks what's already applied, so
    // repeat invocations are safe. Built directly (not via makeFn) because it alone needs
    // packages/db/migrations copied into its bundle -- migrate() reads those files at
    // runtime, and esbuild bundling doesn't pull in non-JS assets on its own.
    this.dbMigrateFn = new nodejs.NodejsFunction(this, "DbMigrate", {
      entry: path.join(REPO_ROOT, "services/lambdas/db-migrate/src/handler.ts"),
      handler: "handler",
      runtime: lambda.Runtime.NODEJS_22_X,
      architecture: lambda.Architecture.ARM_64,
      memorySize: 512,
      timeout: cdk.Duration.minutes(5),
      depsLockFilePath: LOCK_FILE,
      logRetention: logs.RetentionDays.ONE_MONTH,
      environment: commonEnv,
      bundling: {
        ...ESM_BUNDLING,
        commandHooks: {
          beforeBundling: () => [],
          afterBundling: (inputDir: string, outputDir: string) => [
            `cp -r ${inputDir}/packages/db/migrations ${outputDir}/migrations`,
          ],
          beforeInstall: () => [],
        },
      },
    });
    props.cluster.grantDataApiAccess(this.dbMigrateFn);

    // --- Admin API ---
    this.adminApiFn = makeFn(
      "AdminApi",
      "services/lambdas/admin-api/src/handler.ts",
      "handler",
      {
        EBAY_WEBHOOK_ENDPOINT_URL: `${props.apiUrl}/webhooks/ebay/notifications`,
        EBAY_PLATFORM_NOTIFICATION_ENDPOINT_URL: `${props.apiUrl}/webhooks/ebay/platform-notifications`,
        // Commercial-features round's SLO endpoint (GET /admin/slo) reports live DLQ depth --
        // same env var names dlq-redrive already reads, reused here read-only.
        AI_GENERATE_DLQ_URL: props.dlqs.aiGenerate.queueUrl,
        EBAY_SYNC_DLQ_URL: props.dlqs.ebaySync.queueUrl,
        INVENTORY_SYNC_DLQ_URL: props.dlqs.inventorySync.queueUrl,
        // GET /admin/oauth/base/authorize-url (this platform's sole BASE OAuth entry point
        // as of round 12's "public OAuth authorize routeを廃止") needs the same fixed
        // redirect URI BASE's own callback is registered against.
        BASE_OAUTH_REDIRECT_URI: `${props.apiUrl}/oauth/base/callback`,
        // Phase 2's POST /admin/billing/portal-session needs a return_url for the Stripe
        // billing portal session it creates.
        ADMIN_APP_URL: props.adminAppUrl,
      },
      // POST /admin/ebay/webhook-setup blocks on eBay's real challenge-code round trip to our
      // own endpoint during destination creation; GET /admin/commerce-dashboard fans out
      // several DB round trips per product across up to 30 products by default -- both need
      // more than the old 15s, and this comfortably covers either.
      cdk.Duration.seconds(60),
    );
    props.queues.aiGenerate.grantSendMessages(this.adminApiFn);
    props.queues.ebaySync.grantSendMessages(this.adminApiFn);
    props.queues.inventorySync.grantSendMessages(this.adminApiFn);
    for (const dlq of [props.dlqs.aiGenerate, props.dlqs.ebaySync, props.dlqs.inventorySync]) {
      dlq.grant(this.adminApiFn, "sqs:GetQueueAttributes");
    }
    // Needed for POST /admin/ebay/location, which reads eBay app credentials and the
    // connected account's OAuth token (already granted to every fn via makeFn) to create
    // the seller's ship-from location.
    props.appCredentialSecrets.ebay.grantRead(this.adminApiFn);
    // Needed for GET /admin/base/product, a debugging aid that reads BASE app credentials
    // to fetch a single item's raw detail response (e.g. to compare against product_master).
    props.appCredentialSecrets.base.grantRead(this.adminApiFn);
    // Needed for POST /admin/billing/portal-session (Phase 2 of the SaaS conversion).
    props.appCredentialSecrets.stripe.grantRead(this.adminApiFn);
    // Needed for the commercial-features round's AI endpoints (SNS script generation,
    // stale-product suggestions), which call Bedrock directly the same way
    // ai-generate-worker does.
    if (props.config.aiProvider === "openai") {
      props.appCredentialSecrets.openai.grantRead(this.adminApiFn);
    } else {
      this.adminApiFn.addToRolePolicy(
        new iam.PolicyStatement({
          actions: ["bedrock:InvokeModel"],
          resources: ["*"], // see the identical grant on aiGenerateWorkerFn above for why.
        }),
      );
    }

    // productImagesBucket is provisioned for a future image re-hosting step (see README
    // follow-ups); no lambda writes to it yet, so no grant is issued until one does.
    void props.productImagesBucket;
  }
}
