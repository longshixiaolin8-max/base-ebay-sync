import { describe, expect, it } from "vitest";
import { parseModelJson } from "./model-client.js";

describe("parseModelJson", () => {
  it("parses plain JSON", () => {
    expect(parseModelJson('{"a":1}')).toEqual({ a: 1 });
  });

  it("strips markdown JSON code fences before parsing", () => {
    expect(parseModelJson('```json\n{"a":1}\n```')).toEqual({ a: 1 });
  });

  it("throws a descriptive error for non-JSON output", () => {
    expect(() => parseModelJson("not json at all")).toThrow(/not valid JSON/);
  });
});
