import { describe, expect, it } from "vitest";
import { IMPLEMENTED_CHANNELS, otherChannels } from "./channel.js";

describe("otherChannels", () => {
  it("returns every implemented channel except the one given, with today's 2 implemented channels", () => {
    expect(otherChannels("base")).toEqual(["ebay"]);
    expect(otherChannels("ebay")).toEqual(["base"]);
  });

  it("defaults to IMPLEMENTED_CHANNELS when no explicit channel list is given", () => {
    expect(otherChannels("base")).toEqual(IMPLEMENTED_CHANNELS.filter((c) => c !== "base"));
  });

  it("stays correct for an arbitrary N-channel list, not just today's 2", () => {
    expect(otherChannels("base", ["base", "ebay", "shopify"])).toEqual(["ebay", "shopify"]);
    expect(otherChannels("shopify", ["base", "ebay", "shopify"])).toEqual(["base", "ebay"]);
  });

  it("returns an empty array when the channel is the only one in the list", () => {
    expect(otherChannels("base", ["base"])).toEqual([]);
  });
});
