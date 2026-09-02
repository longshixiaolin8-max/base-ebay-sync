import type { ChannelAdapter, OAuthTokenSet } from "@ai-ec/core";
import { oauthConnections, type Database } from "@ai-ec/db";
import {
  CreateSecretCommand,
  GetSecretValueCommand,
  PutSecretValueCommand,
  ResourceNotFoundException,
  SecretsManagerClient,
} from "@aws-sdk/client-secrets-manager";
import { eq, and } from "drizzle-orm";

const secretsClient = new SecretsManagerClient({});

interface StoredToken {
  accessToken: string;
  refreshToken: string | null;
  expiresAt: string;
  scope: string | null;
}

function secretName(channel: string, externalAccountId: string): string {
  return `ai-ec-platform/oauth/${channel}/${externalAccountId}`;
}

/**
 * Persists a freshly obtained OAuth token. The token itself lives only in Secrets
 * Manager — the database stores the secret ARN and a non-sensitive expiry so we can
 * decide when to refresh without reading the secret on every check.
 */
export async function saveOAuthToken(
  db: Database,
  channel: string,
  externalAccountId: string,
  tokens: OAuthTokenSet,
): Promise<void> {
  const name = secretName(channel, externalAccountId);
  const value: StoredToken = {
    accessToken: tokens.accessToken,
    refreshToken: tokens.refreshToken,
    expiresAt: tokens.expiresAt.toISOString(),
    scope: tokens.scope,
  };

  let secretArn: string;
  try {
    const res = await secretsClient.send(
      new PutSecretValueCommand({ SecretId: name, SecretString: JSON.stringify(value) }),
    );
    secretArn = res.ARN!;
  } catch (err) {
    if (!(err instanceof ResourceNotFoundException)) throw err;
    const res = await secretsClient.send(
      new CreateSecretCommand({ Name: name, SecretString: JSON.stringify(value) }),
    );
    secretArn = res.ARN!;
  }

  await db
    .insert(oauthConnections)
    .values({ channel, externalAccountId, secretArn, expiresAt: tokens.expiresAt })
    .onConflictDoUpdate({
      target: [oauthConnections.channel, oauthConnections.externalAccountId],
      set: { secretArn, expiresAt: tokens.expiresAt, updatedAt: new Date() },
    });
}

/**
 * Returns a live access token for the given connection, transparently refreshing (and
 * re-persisting) it if it's within 5 minutes of expiry.
 */
export async function getValidAccessToken(
  db: Database,
  adapter: ChannelAdapter,
  externalAccountId: string,
): Promise<string> {
  const [connection] = await db
    .select()
    .from(oauthConnections)
    .where(and(eq(oauthConnections.channel, adapter.channel), eq(oauthConnections.externalAccountId, externalAccountId)))
    .limit(1);

  if (!connection) {
    throw new Error(`No OAuth connection stored for ${adapter.channel}/${externalAccountId}`);
  }

  const secret = await secretsClient.send(new GetSecretValueCommand({ SecretId: connection.secretArn }));
  const stored = JSON.parse(secret.SecretString ?? "{}") as StoredToken;

  const expiresAt = new Date(stored.expiresAt);
  const isExpiringSoon = expiresAt.getTime() - Date.now() < 5 * 60 * 1000;

  if (!isExpiringSoon) {
    return stored.accessToken;
  }

  if (!stored.refreshToken) {
    throw new Error(`Access token for ${adapter.channel}/${externalAccountId} expired and no refresh token is stored`);
  }

  const refreshed = await adapter.refreshToken(stored.refreshToken);
  await saveOAuthToken(db, adapter.channel, externalAccountId, refreshed);
  return refreshed.accessToken;
}

let appCredentialsCache: Record<string, unknown> = {};

/**
 * Reads this platform's own OAuth app credentials (client id/secret issued by BASE or
 * eBay) from Secrets Manager at runtime — these never appear as plaintext Lambda env
 * vars or in GitHub, only as a secret ARN the Lambda's IAM role is scoped to read.
 */
export async function getAppCredentials<T>(channel: string): Promise<T> {
  if (appCredentialsCache[channel]) return appCredentialsCache[channel] as T;
  const secret = await secretsClient.send(
    new GetSecretValueCommand({ SecretId: `ai-ec-platform/app-credentials/${channel}` }),
  );
  const value = JSON.parse(secret.SecretString ?? "{}") as T;
  appCredentialsCache = { ...appCredentialsCache, [channel]: value };
  return value;
}

export async function listConnectedAccountIds(db: Database, channel: string): Promise<string[]> {
  const rows = await db
    .select({ externalAccountId: oauthConnections.externalAccountId })
    .from(oauthConnections)
    .where(eq(oauthConnections.channel, channel));
  return rows.map((r) => r.externalAccountId);
}
