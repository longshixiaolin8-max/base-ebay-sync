import { describe, expect, it, vi } from "vitest";
import type { Database } from "./client.js";

const isChannelIsolatedMock = vi.fn();
vi.mock("./channel-isolation.js", () => ({
  isChannelIsolated: (...args: unknown[]) => isChannelIsolatedMock(...args),
}));

const computeSyncConfidenceMock = vi.fn();
vi.mock("./sync-confidence.js", () => ({
  computeSyncConfidence: (...args: unknown[]) => computeSyncConfidenceMock(...args),
}));

const { computeChannelSyncState } = await import("./sync-state.js");

function dbWithDriftErrors(driftErrors: unknown[]): Database {
  return { select: () => ({ from: () => ({ where: async () => driftErrors }) }) } as unknown as Database;
}

describe("computeChannelSyncState", () => {
  it("reports ISOLATED when isChannelIsolated says so, without checking anything else", async () => {
    isChannelIsolatedMock.mockResolvedValue({ isolated: true, reasons: ["auth failure"], windowMinutes: 15 });

    const result = await computeChannelSyncState(dbWithDriftErrors([]), "ebay");

    expect(result.state).toBe("ISOLATED");
    expect(computeSyncConfidenceMock).not.toHaveBeenCalled();
  });

  it("reports RECONCILING when inventory-diff-check found recent drift and the channel is not isolated", async () => {
    isChannelIsolatedMock.mockResolvedValue({ isolated: false, reasons: [], windowMinutes: 15 });

    const result = await computeChannelSyncState(dbWithDriftErrors([{ id: "e1" }]), "ebay");

    expect(result.state).toBe("RECONCILING");
  });

  it("reports RECOVERING when isolated over a wider window but not right now", async () => {
    isChannelIsolatedMock
      .mockResolvedValueOnce({ isolated: false, reasons: [], windowMinutes: 15 }) // current window check
      .mockResolvedValueOnce({ isolated: true, reasons: ["was isolated"], windowMinutes: 30 }); // wider window check

    const result = await computeChannelSyncState(dbWithDriftErrors([]), "ebay");

    expect(result.state).toBe("RECOVERING");
  });

  it("reports DEGRADED when confidence is low but nothing else is triggered", async () => {
    isChannelIsolatedMock.mockResolvedValue({ isolated: false, reasons: [], windowMinutes: 15 });
    computeSyncConfidenceMock.mockResolvedValue({ score: 50, windowHours: 24 });

    const result = await computeChannelSyncState(dbWithDriftErrors([]), "ebay");

    expect(result.state).toBe("DEGRADED");
  });

  it("reports HEALTHY when nothing is wrong", async () => {
    isChannelIsolatedMock.mockResolvedValue({ isolated: false, reasons: [], windowMinutes: 15 });
    computeSyncConfidenceMock.mockResolvedValue({ score: 100, windowHours: 24 });

    const result = await computeChannelSyncState(dbWithDriftErrors([]), "ebay");

    expect(result.state).toBe("HEALTHY");
    expect(result.reasons).toEqual([]);
  });
});
