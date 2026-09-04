import { describe, expect, it, vi } from "vitest";

const shouldThrottleChannelMock = vi.fn();
vi.mock("@ai-ec/db", () => ({
  shouldThrottleChannel: (...args: unknown[]) => shouldThrottleChannelMock(...args),
}));

const recordAuditLogMock = vi.fn().mockResolvedValue(undefined);
vi.mock("@ai-ec/lambda-shared", () => ({
  createEbayAdapter: vi.fn(),
  getAppCredentials: vi.fn(),
  getDb: vi.fn(),
  getQueueUrls: vi.fn(),
  pollChannelSales: vi.fn(),
  recordAuditLog: (...args: unknown[]) => recordAuditLogMock(...args),
}));

const { pollChannelIfHealthy } = await import("./handler.js");

describe("pollChannelIfHealthy", () => {
  it("polls the channel when it is not throttled", async () => {
    shouldThrottleChannelMock.mockResolvedValue({ channel: "base", throttle: false, reasons: [], windowMinutes: 15 });
    const poll = vi.fn().mockResolvedValue(undefined);

    await pollChannelIfHealthy({} as never, "base", poll);

    expect(poll).toHaveBeenCalledTimes(1);
    expect(recordAuditLogMock).not.toHaveBeenCalled();
  });

  it("skips polling and records an audit log when the channel is throttled", async () => {
    shouldThrottleChannelMock.mockResolvedValue({
      channel: "ebay",
      throttle: true,
      reasons: ["a rate-limit response (429) was recorded for ebay in the last 15min"],
      windowMinutes: 15,
    });
    const poll = vi.fn().mockResolvedValue(undefined);

    await pollChannelIfHealthy({} as never, "ebay", poll);

    expect(poll).not.toHaveBeenCalled();
    expect(recordAuditLogMock).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ action: "poll_skipped_due_to_throttle", entityId: "ebay" }),
    );
  });

  it("does not let one channel's throttle affect the other channel's own decision", async () => {
    shouldThrottleChannelMock
      .mockResolvedValueOnce({ channel: "base", throttle: true, reasons: ["x"], windowMinutes: 15 })
      .mockResolvedValueOnce({ channel: "ebay", throttle: false, reasons: [], windowMinutes: 15 });
    const pollBase = vi.fn().mockResolvedValue(undefined);
    const pollEbay = vi.fn().mockResolvedValue(undefined);

    await pollChannelIfHealthy({} as never, "base", pollBase);
    await pollChannelIfHealthy({} as never, "ebay", pollEbay);

    expect(pollBase).not.toHaveBeenCalled();
    expect(pollEbay).toHaveBeenCalledTimes(1);
  });
});
