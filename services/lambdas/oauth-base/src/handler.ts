import { BaseAdapter } from "@ai-ec/adapter-base";
import {
  getAppCredentials,
  getDb,
  recordAuditLog,
  requireCloudFrontOrigin,
  requireEnv,
  saveOAuthToken,
  verifyState,
  type BaseAppCredentials,
} from "@ai-ec/lambda-shared";
import type { APIGatewayProxyEventV2, APIGatewayProxyResultV2 } from "aws-lambda";

function redirectUri(): string {
  return requireEnv("BASE_OAUTH_REDIRECT_URI");
}

/** GET /oauth/base/callback?code=...&state=... — exchanges the code and stores the token. */
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

  const creds = await getAppCredentials<BaseAppCredentials>("base");
  let tenantId: string;
  try {
    tenantId = verifyState(creds.clientSecret, state);
  } catch {
    // Never echo errors containing signed state, authorization codes or
    // remote-provider payloads into public responses.
    return { statusCode: 400, body: "Invalid OAuth state" };
  }

  const adapter = new BaseAdapter({ clientId: creds.clientId, clientSecret: creds.clientSecret });
  let tokens: Awaited<ReturnType<BaseAdapter["exchangeCodeForToken"]>>;
  try {
    tokens = await adapter.exchangeCodeForToken(code, redirectUri());
  } catch {
    return { statusCode: 502, body: "BASE authorization failed" };
  }

  // Tenant-isolation fix: this used to fall back to the literal string "default" for every
  // connection (BASE_SHOP_ID was never actually set per-tenant), meaning every tenant's BASE
  // connection collided on the same externalAccountId. getAuthenticatedShopId returns BASE's
  // own real shop_id (GET /1/users/me), unique per shop. If this fails, the connection must
  // not be recorded at all -- a saved connection with no reliable way to identify whose BASE
  // shop it is would be worse than no connection.
  let externalAccountId: string;
  try {
    externalAccountId = await adapter.getAuthenticatedShopId(tokens.accessToken);
  } catch {
    return { statusCode: 502, body: "Could not identify the connected BASE shop" };
  }

  const db = getDb();
  await saveOAuthToken(db, tenantId, "base", externalAccountId, tokens);
  await recordAuditLog(db, {
    tenantId,
    actor: "system:oauth-base-callback",
    action: "oauth_connected",
    entityType: "oauth_connection",
    entityId: `base/${externalAccountId}`,
  });

  return { statusCode: 200, body: "BASE connected successfully. You may close this window." };
}
