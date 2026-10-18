import { beforeEach, describe, expect, it, vi } from "vitest";

const sendMock = vi.fn();

vi.mock("@aws-sdk/client-sqs", () => {
  class FakeCommand {
    constructor(public input: unknown) {}
  }
  return {
    SQSClient: class {
      send(command: unknown) {
        return sendMock(command);
      }
    },
    SendMessageCommand: class extends FakeCommand {},
    GetQueueAttributesCommand: class extends FakeCommand {},
    ListMessageMoveTasksCommand: class extends FakeCommand {},
    StartMessageMoveTaskCommand: class extends FakeCommand {},
    ReceiveMessageCommand: class extends FakeCommand {},
    DeleteMessageCommand: class extends FakeCommand {},
  };
});

const { getApproximateMessageCount, redriveDlq, redriveDlqSelectively } = await import("./sqs.js");

describe("getApproximateMessageCount", () => {
  beforeEach(() => sendMock.mockReset());

  it("parses the count out of GetQueueAttributes", async () => {
    sendMock.mockResolvedValueOnce({ Attributes: { ApproximateNumberOfMessages: "7" } });
    await expect(getApproximateMessageCount("queue-url")).resolves.toBe(7);
  });

  it("defaults to 0 when the attribute is missing", async () => {
    sendMock.mockResolvedValueOnce({ Attributes: {} });
    await expect(getApproximateMessageCount("queue-url")).resolves.toBe(0);
  });
});

describe("redriveDlq", () => {
  beforeEach(() => sendMock.mockReset());

  it("does nothing when the DLQ is empty", async () => {
    sendMock.mockResolvedValueOnce({ Attributes: { ApproximateNumberOfMessages: "0" } });
    const result = await redriveDlq("dlq-url", "dlq-arn");
    expect(result).toEqual({ started: false });
    expect(sendMock).toHaveBeenCalledTimes(1); // only the count check, no move task started
  });

  it("does nothing when a move task is already running for this DLQ", async () => {
    sendMock
      .mockResolvedValueOnce({ Attributes: { ApproximateNumberOfMessages: "3" } })
      .mockResolvedValueOnce({ Results: [{ Status: "RUNNING", TaskHandle: "existing" }] });

    const result = await redriveDlq("dlq-url", "dlq-arn");
    expect(result).toEqual({ started: false });
    expect(sendMock).toHaveBeenCalledTimes(2); // count check + task list, never starts a second one
  });

  it("starts a move task back to the original source queue when the DLQ has messages and no task is running", async () => {
    sendMock
      .mockResolvedValueOnce({ Attributes: { ApproximateNumberOfMessages: "3" } })
      .mockResolvedValueOnce({ Results: [] })
      .mockResolvedValueOnce({ TaskHandle: "new-task" });

    const result = await redriveDlq("dlq-url", "dlq-arn");
    expect(result).toEqual({ started: true, taskHandle: "new-task" });

    const startCommand = sendMock.mock.calls[2]?.[0] as { input: { SourceArn: string; DestinationArn?: string } };
    expect(startCommand.input.SourceArn).toBe("dlq-arn");
    expect(startCommand.input.DestinationArn).toBeUndefined(); // let SQS redrive to the original source
  });
});

describe("redriveDlqSelectively", () => {
  beforeEach(() => sendMock.mockReset());

  it("resubmits a retryable message to the source queue and deletes it from the DLQ", async () => {
    sendMock
      .mockResolvedValueOnce({ Messages: [{ Body: '{"tenantId":"t1"}', ReceiptHandle: "rh-1" }] }) // ReceiveMessage
      .mockResolvedValueOnce({}) // SendMessage to source
      .mockResolvedValueOnce({}) // DeleteMessage from DLQ
      .mockResolvedValueOnce({ Messages: [] }); // next batch: empty, stop

    const isRetryable = vi.fn().mockResolvedValue(true);
    const result = await redriveDlqSelectively("dlq-url", "source-url", isRetryable);

    expect(result).toEqual({ redriven: 1, skipped: 0 });
    expect(isRetryable).toHaveBeenCalledWith('{"tenantId":"t1"}');
    const sendCommand = sendMock.mock.calls[1]?.[0] as { input: { QueueUrl: string; MessageBody: string } };
    expect(sendCommand.input).toEqual({ QueueUrl: "source-url", MessageBody: '{"tenantId":"t1"}' });
    const deleteCommand = sendMock.mock.calls[2]?.[0] as { input: { QueueUrl: string; ReceiptHandle: string } };
    expect(deleteCommand.input).toEqual({ QueueUrl: "dlq-url", ReceiptHandle: "rh-1" });
  });

  it("leaves a non-retryable message untouched in the DLQ -- never resubmitted, never deleted", async () => {
    sendMock
      .mockResolvedValueOnce({ Messages: [{ Body: '{"tenantId":"t1"}', ReceiptHandle: "rh-1" }] })
      .mockResolvedValueOnce({ Messages: [] });

    const isRetryable = vi.fn().mockResolvedValue(false);
    const result = await redriveDlqSelectively("dlq-url", "source-url", isRetryable);

    expect(result).toEqual({ redriven: 0, skipped: 1 });
    expect(sendMock).toHaveBeenCalledTimes(2); // only the two ReceiveMessage calls -- no send/delete
  });

  it("stops immediately once the DLQ reports no messages", async () => {
    sendMock.mockResolvedValueOnce({ Messages: [] });

    const isRetryable = vi.fn();
    const result = await redriveDlqSelectively("dlq-url", "source-url", isRetryable);

    expect(result).toEqual({ redriven: 0, skipped: 0 });
    expect(isRetryable).not.toHaveBeenCalled();
    expect(sendMock).toHaveBeenCalledTimes(1);
  });

  it("is bounded by maxBatches even when the DLQ still has more messages", async () => {
    sendMock.mockResolvedValue({ Messages: [{ Body: "msg", ReceiptHandle: "rh" }] }); // every ReceiveMessage finds one more
    const isRetryable = vi.fn().mockResolvedValue(true);

    const result = await redriveDlqSelectively("dlq-url", "source-url", isRetryable, 2);

    expect(result).toEqual({ redriven: 2, skipped: 0 });
    // 2 batches * (1 receive + 1 send + 1 delete) = 6 total SQS calls, not an 8th (3rd receive)
    expect(sendMock).toHaveBeenCalledTimes(6);
  });
});
