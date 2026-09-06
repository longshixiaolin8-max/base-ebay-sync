import { BOOTSTRAP_TENANT_ID } from "@ai-ec/db";
import {
  createEbayAdapter,
  getAppCredentials,
  getDb,
  recordAuditLog,
  saveOAuthToken,
  signState,
  verifyState,
  type EbayAppCredentials,
} from "@ai-ec/lambda-shared";
import type { APIGatewayProxyEventV2, APIGatewayProxyResultV2 } from "aws-lambda";

/**
 * GET /oauth/ebay/authorize — public, deliberately no tenant hint accepted here (see
 * oauth-state.ts's StatePayload comment). Kept only as a bootstrap path for the one
 * hand-provisioned tenant this platform has today; admin-api's authenticated
 * GET /admin/oauth/ebay/authorize-url is the real per-tenant entry point going forward.
 */
export async function authorize(): Promise<APIGatewayProxyResultV2> {
  const creds = await getAppCredentials<EbayAppCredentials>("ebay");
  const adapter = createEbayAdapter(creds);
  const state = signState(creds.clientSecret, BOOTSTRAP_TENANT_ID);
  const url = adapter.getAuthorizationUrl(state, creds.ruName);
  return { statusCode: 302, headers: { Location: url } };
}

/** GET /oauth/ebay/callback?code=...&state=... — exchanges the code and stores the token. */
export async function callback(event: APIGatewayProxyEventV2): Promise<APIGatewayProxyResultV2> {
  const code = event.queryStringParameters?.code;
  const state = event.queryStringParameters?.state;
  if (!code || !state) {
    return { statusCode: 400, body: "Missing code or state" };
  }

  const creds = await getAppCredentials<EbayAppCredentials>("ebay");
  let tenantId: string;
  try {
    tenantId = verifyState(creds.clientSecret, state);
  } catch (err) {
    return { statusCode: 400, body: `Invalid OAuth state: ${(err as Error).message}` };
  }

  const adapter = createEbayAdapter(creds);
  const tokens = await adapter.exchangeCodeForToken(code);

  const externalAccountId = process.env.EBAY_SELLER_ID ?? "default";

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
