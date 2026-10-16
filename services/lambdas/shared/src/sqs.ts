import {
  DeleteMessageCommand,
  GetQueueAttributesCommand,
  ListMessageMoveTasksCommand,
  ReceiveMessageCommand,
  SendMessageCommand,
  SQSClient,
  StartMessageMoveTaskCommand,
} from "@aws-sdk/client-sqs";

const sqsClient = new SQSClient({});

export async function enqueue(queueUrl: string, body: unknown, dedupeId?: string): Promise<void> {
  await sqsClient.send(
    new SendMessageCommand({
      QueueUrl: queueUrl,
      MessageBody: JSON.stringify(body),
      ...(dedupeId && queueUrl.endsWith(".fifo")
        ? { MessageGroupId: "default", MessageDeduplicationId: dedupeId }
        : {}),
    }),
  );
}

export async function getApproximateMessageCount(queueUrl: string): Promise<number> {
  const res = await sqsClient.send(
    new GetQueueAttributesCommand({ QueueUrl: queueUrl, AttributeNames: ["ApproximateNumberOfMessages"] }),
  );
  return Number(res.Attributes?.ApproximateNumberOfMessages ?? "0");
}

/**
 * Redrives a DLQ's messages back to their original source queue for another attempt, via
 * SQS's native message-move-task feature — the practical "recover after the external API
 * comes back up" step once maxReceiveCount has already given a message several attempts
 * spread over the queue's visibility timeout. A no-op if the DLQ is empty or a move task is
 * already RUNNING for it (SQS only allows one at a time per source anyway).
 */
export async function redriveDlq(dlqUrl: string, dlqArn: string): Promise<{ started: boolean; taskHandle?: string }> {
  const count = await getApproximateMessageCount(dlqUrl);
  if (count === 0) return { started: false };

  const existingTasks = await sqsClient.send(new ListMessageMoveTasksCommand({ SourceArn: dlqArn, MaxResults: 1 }));
  if (existingTasks.Results?.some((t) => t.Status === "RUNNING")) return { started: false };

  const res = await sqsClient.send(new StartMessageMoveTaskCommand({ SourceArn: dlqArn }));
  return { started: true, taskHandle: res.TaskHandle };
}

/**
 * Per-message alternative to redriveDlq, for a DLQ where "blindly move everything back" is
 * unsafe -- today: the eBay sync DLQ, where a seller-privilege block (SELLING_PRIVILEGE_
 * REQUIRED) cannot ever succeed on retry and must not recycle through SQS indefinitely, while
 * a genuinely transient failure (a prolonged eBay outage) that exhausted maxReceiveCount
 * absolutely should recover automatically once the outage ends. SQS's own StartMessageMoveTask
 * has no per-message filtering, so this does the receive/classify/forward loop by hand
 * instead: `isRetryable` is the caller's classifier (today: a DB lookup against this
 * message's most recent sync_errors row), consulted once per message.
 *
 * A message classified non-retryable is left untouched in the DLQ (not deleted) -- it
 * reappears after this call's own receive visibility timeout elapses, for an operator to
 * inspect and act on manually, exactly as today's wholesale-disable already intended for
 * seller-privilege failures.
 *
 * Bounded to a handful of ReceiveMessage calls per invocation (SQS returns at most 10
 * messages per call) rather than draining an arbitrarily large backlog in one Lambda
 * invocation -- a healthy system's eBay DLQ is small (an outage window's worth of
 * messages), and a large one is itself something an operator should notice, not something
 * this should spend unbounded Lambda time silently working through.
 */
export async function redriveDlqSelectively(
  dlqUrl: string,
  sourceQueueUrl: string,
  isRetryable: (messageBody: string) => Promise<boolean>,
  maxBatches = 5,
): Promise<{ redriven: number; skipped: number }> {
  let redriven = 0;
  let skipped = 0;

  for (let batch = 0; batch < maxBatches; batch++) {
    const res = await sqsClient.send(new ReceiveMessageCommand({ QueueUrl: dlqUrl, MaxNumberOfMessages: 10, VisibilityTimeout: 30 }));
    const messages = res.Messages ?? [];
    if (messages.length === 0) break;

    for (const msg of messages) {
      if (!msg.Body || !msg.ReceiptHandle) continue;

      const retryable = await isRetryable(msg.Body);
      if (!retryable) {
        skipped++;
        continue;
      }

      await sqsClient.send(new SendMessageCommand({ QueueUrl: sourceQueueUrl, MessageBody: msg.Body }));
      await sqsClient.send(new DeleteMessageCommand({ QueueUrl: dlqUrl, ReceiptHandle: msg.ReceiptHandle }));
      redriven++;
    }
  }

  return { redriven, skipped };
}
