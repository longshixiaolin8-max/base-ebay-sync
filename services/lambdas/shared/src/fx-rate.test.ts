import { beforeEach, describe, expect, it, vi } from "vitest";
import { fetchFxRate } from "./fx-rate.js";

describe("fetchFxRate", () => {
  beforeEach(() => {
    vi.unstubAllGlobals();
  });

  it("returns the real USD rate from the FX API response", async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ amount: 1, base: "JPY", rates: { USD: 0.0068 } }),
      text: async () => "",
    });
    vi.stubGlobal("fetch", fetchMock);

    const result = await fetchFxRate();

    expect(result.fxRateUsdPerJpy).toBe(0.0068);
    expect(result.source).toMatch(/frankfurter/i);
    expect(fetchMock).toHaveBeenCalledWith(expect.stringContaining("frankfurter.app"));
  });

  it("throws when the API responds with a non-ok status", async () => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: false, status: 503, json: async () => ({}), text: async () => "down" });
    vi.stubGlobal("fetch", fetchMock);

    await expect(fetchFxRate()).rejects.toThrow(/FX rate API error 503/);
  });

  it("throws when the response has no usable USD rate", async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ rates: {} }),
      text: async () => "",
    });
    vi.stubGlobal("fetch", fetchMock);

    await expect(fetchFxRate()).rejects.toThrow(/no usable USD rate/);
  });
});
