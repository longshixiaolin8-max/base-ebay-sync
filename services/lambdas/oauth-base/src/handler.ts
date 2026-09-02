import { BaseAdapter } from "@ai-ec/adapter-base";
import { getAppCredentials, getDb, recordAuditLog, requireEnv, saveOAuthToken, signState, verifyState } from "@ai-ec/lambda-shared";
import type { APIGatewayProxyEventV2, APIGatewayProxyResultV2 } from "aws-lambda";

interface BaseAppCredentials {
  clientId: string;
  clientSecret: string;
}

async function createAdapter(): Promise<BaseAdapter> {
  const creds = await getAppCredentials<BaseAppCredentials>("base");
  return new BaseAdapter({ clientId: creds.clientId, clientSecret: creds.clientSecret });
}

function redirectUri(): string {
  return requireEnv("BASE_OAUTH_REDIRECT_URI");
}

/** GET /oauth/base/authorize — redirects the admin operator to BASE's consent screen. */
export async function authorize(): Promise<APIGatewayProxyResultV2> {
  const adapter = await createAdapter();
  const creds = await getAppCredentials<BaseAppCredentials>("base");
  const state = signState(creds.clientSecret);
  const url = adapter.getAuthorizationUrl(state, redirectUri());
  return { statusCode: 302, headers: { Location: url } };
}

/** GET /oauth/base/callback?code=...&state=... — exchanges the code and stores the token. */
export async function callback(event: APIGatewayProxyEventV2): Promise<APIGatewayProxyResultV2> {
  const code = event.queryStringParameters?.code;
  const state = event.queryStringParameters?.state;
  if (!code || !state) {
    return { statusCode: 400, body: "Missing code or state" };
  }

  const creds = await getAppCredentials<BaseAppCredentials>("base");
  try {
    verifyState(creds.clientSecret, state);
  } catch (err) {
    return { statusCode: 400, body: `Invalid OAuth state: ${(err as Error).message}` };
  }

  const adapter = new BaseAdapter({ clientId: creds.clientId, clientSecret: creds.clientSecret });
  const tokens = await adapter.exchangeCodeForToken(code, redirectUri());

  // BASE's token response does not include a shop id in this simplified flow; the shop
  // is identified from the first authenticated API call. For a single-shop deployment,
  // "default" is a stable account key; multi-shop support can key this off the real id.
  const externalAccountId = process.env.BASE_SHOP_ID ?? "default";

  const db = getDb();
  await saveOAuthToken(db, "base", externalAccountId, tokens);
  await recordAuditLog(db, {
    actor: "system:oauth-base-callback",
    action: "oauth_connected",
    entityType: "oauth_connection",
    entityId: `base/${externalAccountId}`,
  });

  return { statusCode: 200, body: "BASE connected successfully. You may close this window." };
}
