import { timingSafeEqual } from "node:crypto";
import type { APIGatewayProxyEventV2, APIGatewayProxyResultV2 } from "aws-lambda";

/**
 * Round 15 hardening ("WAFを実際の本番経路に適用" -- restricting the direct execute-api
 * URL). HTTP API v2 supports neither a resource policy nor a direct WAF Web ACL
 * association (confirmed against AWS's own docs) -- unlike REST API v1, there is no way to
 * reject "didn't come through CloudFront" at the API Gateway layer itself. The recommended
 * alternative (also AWS's own guidance, not a guess): CloudFront injects a shared-secret
 * custom header on every request it forwards to the origin (see cloudfront-stack.ts's
 * customHeaders); a request that skipped CloudFront and hit execute-api directly never
 * carries it.
 *
 * Deliberately a no-op (returns null, meaning "allowed, proceed") when
 * CLOUDFRONT_SHARED_SECRET isn't set at all -- that's PlatformConfig.apiEntrypoint still
 * "direct" (today's default, unchanged), where nothing has been told to expect this header
 * yet. Only once apiEntrypoint flips to "cloudfront" (see README's runbook) does the env
 * var get set and this check start actually enforcing anything, so this round's own deploy
 * can never itself break live traffic that's still using the direct URL.
 */
export function requireCloudFrontOrigin(event: APIGatewayProxyEventV2): APIGatewayProxyResultV2 | null {
  const expected = process.env.CLOUDFRONT_SHARED_SECRET;
  if (!expected) return null;

  const provided = event.headers?.["x-cloudfront-secret"] ?? event.headers?.["X-CloudFront-Secret"];
  if (!provided) return { statusCode: 403, body: "Direct access to this API is not permitted" };

  const a = Buffer.from(provided);
  const b = Buffer.from(expected);
  if (a.length !== b.length || !timingSafeEqual(a, b)) {
    return { statusCode: 403, body: "Direct access to this API is not permitted" };
  }

  return null;
}
