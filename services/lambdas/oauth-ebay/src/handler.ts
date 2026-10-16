import {
  createEbayAdapter,
  getAppCredentials,
  getDb,
  recordAuditLog,
  requireCloudFrontOrigin,
  saveOAuthToken,
  verifyState,
  type EbayAppCredentials,
} from "@ai-ec/lambda-shared";
import type { APIGatewayProxyEventV2, APIGatewayProxyResultV2 } from "aws-lambda";

/** GET /oauth/ebay/callback?code=...&state=... — exchanges the code and stores the token. */
export async function callback(event: APIGatewayProxyEventV2): Promise<APIGatewayProxyResultV2> {
  const cloudFrontRejection = requireCloudFrontOrigin(event);
  if (cloudFrontRejection) return cloudFrontRejection;

  const code = event.queryStringParameters?.code;
  const state = event.queryStringParameters?.state;
  if (!code || !state) {
    return { statusCode: 400, body: "Missing code or state" };
  }
  if (code.length > 2048 || state.length > 1024) {
    return { statusCode: 400, body: "Invalid OAuth callback parameters" };
  }

  const creds = await getAppCredentials<EbayAppCredentials>("ebay");
  let tenantId: string;
  try {
    tenantId = verifyState(creds.clientSecret, state);
  } catch {
    // Never echo errors containing signed state, authorization codes or
    // remote-provider payloads into public responses.
    return { statusCode: 400, body: "Invalid OAuth state" };
  }

  const adapter = createEbayAdapter(creds);
  let tokens: Awaited<ReturnType<typeof adapter.exchangeCodeForToken>>;
  try {
    tokens = await adapter.exchangeCodeForToken(code);
  } catch {
    return { statusCode: 502, body: "eBay authorization failed" };
  }

  // Tenant-isolation fix: this used to fall back to the literal string "default" whenever
  // EBAY_SELLER_ID wasn't set, which every tenant's connection hit in practice (that env var
  // was never actually set per-tenant) -- meaning every tenant's eBay connection collided on
  // the same externalAccountId. getAuthenticatedUserId returns eBay's own immutable user id,
  // which is unique per real eBay account and is also what eBay's own
  // MARKETPLACE_ACCOUNT_DELETION notification identifies the account by. If this fails (e.g.
  // the connected token lacks the commerce.identity.readonly scope), the connection must not
  // be recorded at all -- a saved connection with no way to reliably identify whose eBay
  // account it is would be worse than no connection.
  let externalAccountId: string;
  try {
    externalAccountId = await adapter.getAuthenticatedUserId(tokens.accessToken);
  } catch {
    return { statusCode: 502, body: "Could not identify the connected eBay account" };
  }

  const db = getDb();
  await saveOAuthToken(db, tenantId, "ebay", externalAccountId, tokens);
  await recordAuditLog(db, {
    tenantId,
    actor: "system:oauth-ebay-callback",
    action: "oauth_connected",
    entityType: "oauth_connection",
    entityId: `ebay/${externalAccountId}`,
  });

  return { statusCode: 200, body: "eBay connected successfully. You may close this window." };
}
