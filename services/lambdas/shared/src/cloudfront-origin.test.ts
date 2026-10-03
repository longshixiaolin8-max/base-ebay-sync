import type { APIGatewayProxyEventV2 } from "aws-lambda";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { requireCloudFrontOrigin } from "./cloudfront-origin.js";

function makeEvent(headers: Record<string, string> = {}): APIGatewayProxyEventV2 {
  return { headers } as unknown as APIGatewayProxyEventV2;
}

describe("requireCloudFrontOrigin", () => {
  const original = process.env.CLOUDFRONT_SHARED_SECRET;

  afterEach(() => {
    if (original === undefined) delete process.env.CLOUDFRONT_SHARED_SECRET;
    else process.env.CLOUDFRONT_SHARED_SECRET = original;
  });

  it("is a no-op (allows the request) when CLOUDFRONT_SHARED_SECRET isn't configured -- apiEntrypoint still 'direct'", () => {
    delete process.env.CLOUDFRONT_SHARED_SECRET;
    const result = requireCloudFrontOrigin(makeEvent());
    expect(result).toBeNull();
  });

  describe("once CLOUDFRONT_SHARED_SECRET is configured (apiEntrypoint 'cloudfront')", () => {
    beforeEach(() => {
      process.env.CLOUDFRONT_SHARED_SECRET = "the-real-shared-secret";
    });

    it("allows a request carrying the correct header", () => {
      const result = requireCloudFrontOrigin(makeEvent({ "x-cloudfront-secret": "the-real-shared-secret" }));
      expect(result).toBeNull();
    });

    it("is case-insensitive on the header name itself, matching how API Gateway lowercases headers", () => {
      const result = requireCloudFrontOrigin(makeEvent({ "X-CloudFront-Secret": "the-real-shared-secret" }));
      expect(result).toBeNull();
    });

    it("rejects a request with no header at all -- a direct hit on execute-api", () => {
      const result = requireCloudFrontOrigin(makeEvent());
      expect(result).toEqual({ statusCode: 403, body: "Direct access to this API is not permitted" });
    });

    it("rejects a request with the wrong secret value", () => {
      const result = requireCloudFrontOrigin(makeEvent({ "x-cloudfront-secret": "guessed-wrong-value" }));
      expect(result).toEqual({ statusCode: 403, body: "Direct access to this API is not permitted" });
    });

    it("rejects a value of a different length without throwing (timingSafeEqual's own length precondition)", () => {
      const result = requireCloudFrontOrigin(makeEvent({ "x-cloudfront-secret": "short" }));
      expect(result).toEqual({ statusCode: 403, body: "Direct access to this API is not permitted" });
    });
  });
});
