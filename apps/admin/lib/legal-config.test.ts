import { describe, expect, it } from "vitest";
import { LEGAL_INFO } from "./legal-config";

describe("public legal configuration", () => {
  it("never exposes operator name, physical address or phone via the public config", () => {
    expect(Object.keys(LEGAL_INFO)).toEqual(["email"]);
    expect(LEGAL_INFO).not.toHaveProperty("operatorName");
    expect(LEGAL_INFO).not.toHaveProperty("address");
    expect(LEGAL_INFO).not.toHaveProperty("phone");
  });
});
