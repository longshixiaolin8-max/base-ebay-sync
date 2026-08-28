import { SQSClient, SendMessageCommand } from "@aws-sdk/client-sqs";

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
