import {
  GetQueueAttributesCommand,
  ListMessageMoveTasksCommand,
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
