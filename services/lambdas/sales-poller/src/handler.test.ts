import { describe, expect, it, vi } from "vitest";

const isChannelIsolatedMock = vi.fn();
vi.mock("@ai-ec/db", () => ({
  isChannelIsolated: (...args: unknown[]) => isChannelIsolatedMock(...args),
}));

const recordAuditLogMock = vi.fn().mockResolvedValue(undefined);
const recordSyncErrorMock = vi.fn().mockResolvedValue(undefined);
const emitChannelIsolatedMetricMock = vi.fn();
vi.mock("@ai-ec/lambda-shared", () => ({
  createEbayAdapter: vi.fn(),
  emitChannelIsolatedMetric: (...args: unknown[]) => emitChannelIsolatedMetricMock(...args),
  getAppCredentials: vi.fn(),
  getDb: vi.fn(),
  getQueueUrls: vi.fn(),
  pollChannelSales: vi.fn(),
  recordAuditLog: (...args: unknown[]) => recordAuditLogMock(...args),
  recordSyncError: (...args: unknown[]) => recordSyncErrorMock(...args),
}));

const { pollChannelIfHealthy } = await import("./handler.js");

describe("pollChannelIfHealthy", () => {
  it("polls the channel when it is not isolated", async () => {
    isChannelIsolatedMock.mockResolvedValue({ channel: "base", isolated: false, reasons: [], windowMinutes: 15 });
    const poll = vi.fn().mockResolvedValue(undefined);

    await pollChannelIfHealthy({} as never, "base", poll);

    expect(poll).toHaveBeenCalledTimes(1);
    expect(recordAuditLogMock).not.toHaveBeenCalled();
  });

  it("skips polling and records an audit log when the channel is isolated", async () => {
    isChannelIsolatedMock.mockResolvedValue({
      channel: "ebay",
      isolated: true,
      reasons: ["an authentication failure was recorded for ebay in the last 15min"],
      windowMinutes: 15,
    });
    const poll = vi.fn().mockResolvedValue(undefined);

    await pollChannelIfHealthy({} as never, "ebay", poll);

    expect(poll).not.toHaveBeenCalled();
    expect(recordAuditLogMock).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ action: "channel_isolated_skip", entityId: "ebay" }),
    );
    expect(emitChannelIsolatedMetricMock).toHaveBeenCalledWith("ebay");
  });

  it("does not let one channel's isolation affect the other channel's own decision", async () => {
    isChannelIsolatedMock
      .mockResolvedValueOnce({ channel: "base", isolated: true, reasons: ["x"], windowMinutes: 15 })
      .mockResolvedValueOnce({ channel: "ebay", isolated: false, reasons: [], windowMinutes: 15 });
    const pollBase = vi.fn().mockResolvedValue(undefined);
    const pollEbay = vi.fn().mockResolvedValue(undefined);

    await pollChannelIfHealthy({} as never, "base", pollBase);
    await pollChannelIfHealthy({} as never, "ebay", pollEbay);

    expect(pollBase).not.toHaveBeenCalled();
    expect(pollEbay).toHaveBeenCalledTimes(1);
  });

  it("records the failure as a channel-tagged sync error instead of letting it escape uncaught", async () => {
    // Regression: confirmed live that an unhandled poll() failure here used to abort the
    // whole Lambda invocation (an opaque top-level "Invoke Error"), invisible to
    // isChannelIsolated/computeSyncConfidence since they only read sync_errors.
    isChannelIsolatedMock.mockResolvedValue({ channel: "ebay", isolated: false, reasons: [], windowMinutes: 15 });
    const poll = vi.fn().mockRejectedValue(new Error("Access token for ebay/default expired and no refresh token is stored"));

    await expect(pollChannelIfHealthy({} as never, "ebay", poll)).resolves.toBeUndefined();

    expect(recordSyncErrorMock).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        channel: "ebay",
        errorCode: "sales_poll_failed",
        errorMessage: "Access token for ebay/default expired and no refresh token is stored",
      }),
    );
  });

  it("never lets a failed poll for one channel propagate and block the next channel's own poll", async () => {
    isChannelIsolatedMock.mockResolvedValue({ channel: "base", isolated: false, reasons: [], windowMinutes: 15 });
    const pollBase = vi.fn().mockRejectedValue(new Error("boom"));
    const pollEbay = vi.fn().mockResolvedValue(undefined);

    await pollChannelIfHealthy({} as never, "base", pollBase);
    await pollChannelIfHealthy({} as never, "ebay", pollEbay);

    expect(pollEbay).toHaveBeenCalledTimes(1);
  });
});
