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
  };
});

const { getApproximateMessageCount, redriveDlq } = await import("./sqs.js");

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
