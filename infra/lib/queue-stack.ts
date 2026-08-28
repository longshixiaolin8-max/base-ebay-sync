import * as cdk from "aws-cdk-lib";
import * as sqs from "aws-cdk-lib/aws-sqs";
import type { Construct } from "constructs";

interface QueuePair {
  queue: sqs.Queue;
  dlq: sqs.Queue;
}

function makeQueuePair(scope: Construct, name: string, visibilityTimeoutSeconds: number): QueuePair {
  const dlq = new sqs.Queue(scope, `${name}Dlq`, {
    retentionPeriod: cdk.Duration.days(14),
    encryption: sqs.QueueEncryption.SQS_MANAGED,
  });

  const queue = new sqs.Queue(scope, `${name}Queue`, {
    visibilityTimeout: cdk.Duration.seconds(visibilityTimeoutSeconds),
    retentionPeriod: cdk.Duration.days(4),
    encryption: sqs.QueueEncryption.SQS_MANAGED,
    deadLetterQueue: { queue: dlq, maxReceiveCount: 5 },
  });

  return { queue, dlq };
}

/** One queue + DLQ per sync stage, per requirement #10/#11 (SQS Retry / DLQ). */
export class QueueStack extends cdk.Stack {
  readonly aiGenerate: QueuePair;
  readonly ebaySync: QueuePair;
  readonly inventorySync: QueuePair;

  constructor(scope: Construct, id: string, props?: cdk.StackProps) {
    super(scope, id, props);

    this.aiGenerate = makeQueuePair(this, "AiGenerate", 60);
    this.ebaySync = makeQueuePair(this, "EbaySync", 30);
    this.inventorySync = makeQueuePair(this, "InventorySync", 30);
  }
}
