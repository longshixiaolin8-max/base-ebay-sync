import type { ChannelAdapter, OAuthTokenSet } from "@ai-ec/core";
import { oauthConnections, type Database } from "@ai-ec/db";
import {
  CreateSecretCommand,
  DeleteSecretCommand,
  GetSecretValueCommand,
  PutSecretValueCommand,
  ResourceNotFoundException,
  SecretsManagerClient,
} from "@aws-sdk/client-secrets-manager";
import { eq, and } from "drizzle-orm";

const secretsClient = new SecretsManagerClient({});

// Matches infra/lib/secrets-stack.ts's per-env naming: every env except "dev" gets an
// `${envName}/` segment (dev is kept unprefixed for backward compatibility with its
// already-populated real credentials). dev and prod run side by side in the same AWS
// account, so every secret name read/written at runtime must include this segment or the
// two would collide on the same name.
const PLATFORM_ENV = process.env.PLATFORM_ENV ?? "dev";
const ENV_SEGMENT = PLATFORM_ENV === "dev" ? "" : `${PLATFORM_ENV}/`;

interface StoredToken {
  accessToken: string;
  refreshToken: string | null;
  expiresAt: string;
  scope: string | null;
}

/**
 * tenantId is a required, non-optional segment of the secret name itself -- not just of
 * the oauth_connections DB row -- because externalAccountId is not reliably unique across
 * tenants in practice (see e.g. oauth-base/oauth-ebay's own "default" fallback prior to the
 * tenant-isolation fix). Without it, two tenants that both resolve to the same
 * (channel, externalAccountId) would share the exact same Secrets Manager secret NAME, and
 * since Secrets Manager has no per-tenant concept of its own, the second tenant's
 * PutSecretValueCommand would silently overwrite the first tenant's live OAuth token --
 * even though their oauth_connections rows are correctly kept separate by tenantId.
 */
function secretName(tenantId: string, channel: string, externalAccountId: string): string {
  return `ai-ec-platform/${ENV_SEGMENT}oauth/${tenantId}/${channel}/${externalAccountId}`;
}

/**
 * Persists a freshly obtained OAuth token. The token itself lives only in Secrets
 * Manager — the database stores the secret ARN and a non-sensitive expiry so we can
 * decide when to refresh without reading the secret on every check.
 */
export async function saveOAuthToken(
  db: Database,
  tenantId: string,
  channel: string,
  externalAccountId: string,
  tokens: OAuthTokenSet,
): Promise<void> {
  const name = secretName(tenantId, channel, externalAccountId);
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
    .values({ tenantId, channel, externalAccountId, secretArn, expiresAt: tokens.expiresAt })
    .onConflictDoUpdate({
      target: [oauthConnections.tenantId, oauthConnections.channel, oauthConnections.externalAccountId],
      set: { secretArn, expiresAt: tokens.expiresAt, updatedAt: new Date() },
    });
}

/**
 * Returns a live access token for the given connection, transparently refreshing (and
 * re-persisting) it if it's within 5 minutes of expiry.
 */
export async function getValidAccessToken(
  db: Database,
  tenantId: string,
  adapter: ChannelAdapter,
  externalAccountId: string,
): Promise<string> {
  const [connection] = await db
    .select()
    .from(oauthConnections)
    .where(
      and(
        eq(oauthConnections.tenantId, tenantId),
        eq(oauthConnections.channel, adapter.channel),
        eq(oauthConnections.externalAccountId, externalAccountId),
      ),
    )
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
  await saveOAuthToken(db, tenantId, adapter.channel, externalAccountId, refreshed);
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
    new GetSecretValueCommand({ SecretId: `ai-ec-platform/${ENV_SEGMENT}app-credentials/${channel}` }),
  );
  const value = JSON.parse(secret.SecretString ?? "{}") as T;
  appCredentialsCache = { ...appCredentialsCache, [channel]: value };
  return value;
}

export interface DeletedOAuthConnection {
  tenantId: string;
  secretArn: string;
}

/** Shared by both delete-connections functions below: best-effort removes each row's
 *  Secrets Manager secret, tolerating one that's already gone (a retried offboarding pass,
 *  or a connection whose secret was somehow already cleaned up). */
async function deleteSecretsFor(rows: { secretArn: string }[]): Promise<void> {
  for (const row of rows) {
    try {
      await secretsClient.send(new DeleteSecretCommand({ SecretId: row.secretArn, ForceDeleteWithoutRecovery: true }));
    } catch (err) {
      if (!(err instanceof ResourceNotFoundException)) throw err;
    }
  }
}

/**
 * Marketplace Account Deletion compliance (eBay's Platform Notifications requirement for
 * every production keyset): permanently removes every oauth_connections row for a given
 * channel + externalAccountId -- across all tenants, since eBay's notification names the
 * external account, not which of our tenants it belongs to -- and the Secrets Manager
 * secret each one points at. Irreversible by design; this is real personal-data deletion,
 * not a soft status flag like the rest of this app's channel-connection state.
 */
export async function deleteOAuthConnectionsByExternalAccount(
  db: Database,
  channel: string,
  externalAccountId: string,
): Promise<DeletedOAuthConnection[]> {
  const rows = await db
    .delete(oauthConnections)
    .where(and(eq(oauthConnections.channel, channel), eq(oauthConnections.externalAccountId, externalAccountId)))
    .returning({ tenantId: oauthConnections.tenantId, secretArn: oauthConnections.secretArn });

  await deleteSecretsFor(rows);
  return rows;
}

/**
 * Tenant-initiated OAuth revoke (tenant-offboarding's final step, once every one of that
 * tenant's published listings on `channel` has been confirmed delisted): removes this
 * tenant's own oauth_connections row(s) for `channel` and their Secrets Manager secrets.
 * Deliberately scoped by tenantId, unlike deleteOAuthConnectionsByExternalAccount above --
 * that function's whole point is reacting to an external party naming an account with no
 * tenant context at all, which would be the wrong (too broad) tool for revoking one
 * specific tenant's own connection.
 */
export async function deleteOAuthConnectionsForTenant(db: Database, tenantId: string, channel: string): Promise<DeletedOAuthConnection[]> {
  const rows = await db
    .delete(oauthConnections)
    .where(and(eq(oauthConnections.tenantId, tenantId), eq(oauthConnections.channel, channel)))
    .returning({ tenantId: oauthConnections.tenantId, secretArn: oauthConnections.secretArn });

  await deleteSecretsFor(rows);
  return rows;
}

export async function listConnectedAccountIds(db: Database, tenantId: string, channel: string): Promise<string[]> {
  const rows = await db
    .select({ externalAccountId: oauthConnections.externalAccountId })
    .from(oauthConnections)
    .where(and(eq(oauthConnections.tenantId, tenantId), eq(oauthConnections.channel, channel)));
  return rows.map((r) => r.externalAccountId);
}
