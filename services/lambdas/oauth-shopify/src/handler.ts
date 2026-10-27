import {
  createShopifyAdapter,
  getAppCredentials,
  getDb,
  normalizeShopDomain,
  recordAuditLog,
  requireCloudFrontOrigin,
  requireEnv,
  saveOAuthToken,
  verifyState,
  type ShopifyAppCredentials,
} from "@ai-ec/lambda-shared";
import type { APIGatewayProxyEventV2, APIGatewayProxyResultV2 } from "aws-lambda";

function redirectUri(): string {
  return requireEnv("SHOPIFY_OAUTH_REDIRECT_URI");
}

/**
 * GET /oauth/shopify/callback?code=...&state=...&shop=... -- exchanges the code and stores
 * the token. Unlike BASE/eBay (whose externalAccountId needs its own post-token-exchange
 * identity call -- getAuthenticatedShopId/getAuthenticatedUserId), Shopify's own `shop` query
 * param (present on both the authorize redirect this platform sends merchants to, see
 * admin-api's GET /admin/oauth/shopify/authorize-url, and this callback) already *is* a
 * stable, unique-per-store identifier -- no extra API call needed to resolve one.
 */
export async function callback(event: APIGatewayProxyEventV2): Promise<APIGatewayProxyResultV2> {
  const cloudFrontRejection = requireCloudFrontOrigin(event);
  if (cloudFrontRejection) return cloudFrontRejection;

  const code = event.queryStringParameters?.code;
  const state = event.queryStringParameters?.state;
  const shop = event.queryStringParameters?.shop;
  if (!code || !state || !shop) {
    return { statusCode: 400, body: "Missing code, state or shop" };
  }
  if (code.length > 2048 || state.length > 1024 || shop.length > 128) {
    return { statusCode: 400, body: "Invalid OAuth callback parameters" };
  }

  let shopDomain: string;
  try {
    shopDomain = normalizeShopDomain(shop);
  } catch {
    return { statusCode: 400, body: "Invalid shop domain" };
  }

  const creds = await getAppCredentials<ShopifyAppCredentials>("shopify");
  let tenantId: string;
  try {
    tenantId = verifyState(creds.clientSecret, state);
  } catch {
    // Never echo errors containing signed state, authorization codes or
    // remote-provider payloads into public responses.
    return { statusCode: 400, body: "Invalid OAuth state" };
  }

  const adapter = createShopifyAdapter(creds, shopDomain);
  let tokens: Awaited<ReturnType<typeof adapter.exchangeCodeForToken>>;
  try {
    tokens = await adapter.exchangeCodeForToken(code, redirectUri());
  } catch {
    // Also covers a mismatched shop: Shopify's own token endpoint rejects a code that wasn't
    // issued for the exact store this request names, the same way a forged `shop` value
    // would -- no separate cross-check needed here beyond this call itself failing.
    return { statusCode: 502, body: "Shopify authorization failed" };
  }

  const db = getDb();
  await saveOAuthToken(db, tenantId, "shopify", shopDomain, tokens);
  await recordAuditLog(db, {
    tenantId,
    actor: "system:oauth-shopify-callback",
    action: "oauth_connected",
    entityType: "oauth_connection",
    entityId: `shopify/${shopDomain}`,
  });

  return { statusCode: 200, body: "Shopify connected successfully. You may close this window." };
}
