import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { emitChannelIsolatedMetric, emitSyncErrorMetric } from "./metrics.js";

describe("metrics", () => {
  let logSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    logSpy = vi.spyOn(console, "log").mockImplementation(() => undefined);
  });

  afterEach(() => {
    logSpy.mockRestore();
  });

  it("emits an EMF log line for a sync error with both a Channel-only and a Channel+ErrorCode dimension set", () => {
    emitSyncErrorMetric("ebay", "ai_generate_failed");

    expect(logSpy).toHaveBeenCalledTimes(1);
    const emitted = JSON.parse(logSpy.mock.calls[0]![0] as string);
    expect(emitted.Channel).toBe("ebay");
    expect(emitted.ErrorCode).toBe("ai_generate_failed");
    expect(emitted.SyncErrors).toBe(1);
    expect(emitted._aws.CloudWatchMetrics[0].Namespace).toBe("AiEcPlatform");
    expect(emitted._aws.CloudWatchMetrics[0].Dimensions).toEqual([["Channel"], ["Channel", "ErrorCode"]]);
  });

  it("falls back to 'unknown' for a null channel", () => {
    emitSyncErrorMetric(null, "sales_poll_failed");
    const emitted = JSON.parse(logSpy.mock.calls[0]![0] as string);
    expect(emitted.Channel).toBe("unknown");
  });

  it("emits a Channel-only EMF log line for channel isolation", () => {
    emitChannelIsolatedMetric("ebay");

    const emitted = JSON.parse(logSpy.mock.calls[0]![0] as string);
    expect(emitted.Channel).toBe("ebay");
    expect(emitted.ChannelIsolated).toBe(1);
    expect(emitted._aws.CloudWatchMetrics[0].Dimensions).toEqual([["Channel"]]);
  });
});
