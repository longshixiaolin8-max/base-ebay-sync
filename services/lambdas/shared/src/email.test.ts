import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const sendMock = vi.fn();

vi.mock("@aws-sdk/client-sesv2", () => {
  class FakeCommand {
    constructor(public input: unknown) {}
  }
  return {
    SESv2Client: class {
      send(command: unknown) {
        return sendMock(command);
      }
    },
    SendEmailCommand: class extends FakeCommand {},
  };
});

const { sendEmail } = await import("./email.js");

describe("sendEmail", () => {
  const originalFromEmail = process.env.SES_FROM_EMAIL;

  beforeEach(() => {
    sendMock.mockReset().mockResolvedValue({ MessageId: "msg-1" });
    process.env.SES_FROM_EMAIL = "notifications@example.com";
  });

  afterEach(() => {
    if (originalFromEmail === undefined) delete process.env.SES_FROM_EMAIL;
    else process.env.SES_FROM_EMAIL = originalFromEmail;
  });

  it("throws a clear error when SES_FROM_EMAIL isn't configured, instead of silently no-op'ing", async () => {
    delete process.env.SES_FROM_EMAIL;
    await expect(sendEmail({ to: "seller@example.com", subject: "s", bodyText: "b" })).rejects.toThrow(/SES_FROM_EMAIL is not configured/);
    expect(sendMock).not.toHaveBeenCalled();
  });

  it("sends a plain-text email via SES v2 with the configured from address", async () => {
    await sendEmail({ to: "seller@example.com", subject: "請求のお知らせ", bodyText: "お支払いに失敗しました。" });

    expect(sendMock).toHaveBeenCalledTimes(1);
    const command = sendMock.mock.calls[0]![0] as { input: unknown };
    expect(command.input).toEqual({
      FromEmailAddress: "notifications@example.com",
      Destination: { ToAddresses: ["seller@example.com"] },
      Content: {
        Simple: {
          Subject: { Data: "請求のお知らせ", Charset: "UTF-8" },
          Body: { Text: { Data: "お支払いに失敗しました。", Charset: "UTF-8" } },
        },
      },
    });
  });
});
