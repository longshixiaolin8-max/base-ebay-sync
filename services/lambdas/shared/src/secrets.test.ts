import { beforeEach, describe, expect, it, vi } from "vitest";

// PLATFORM_ENV is read once at module load time (see secrets.ts's ENV_SEGMENT const), so it
// must be set before the dynamic import below.
process.env.PLATFORM_ENV = "prod";

interface FakeCommandInput {
  SecretId?: string;
  Name?: string;
  SecretString?: string;
  ForceDeleteWithoutRecovery?: boolean;
}

class FakeCommand {
  constructor(readonly input: FakeCommandInput) {}
}

const sendMock = vi.fn();

vi.mock("@aws-sdk/client-secrets-manager", () => ({
  SecretsManagerClient: vi.fn().mockImplementation(() => ({ send: sendMock })),
  GetSecretValueCommand: FakeCommand,
  PutSecretValueCommand: FakeCommand,
  CreateSecretCommand: FakeCommand,
  DeleteSecretCommand: FakeCommand,
  ResourceNotFoundException: class ResourceNotFoundException extends Error {},
}));

const { deleteOAuthConnectionsByExternalAccount, deleteOAuthConnectionsForTenant, saveOAuthToken } = await import("./secrets.js");

function fakeDb() {
  return {
    insert: () => ({
      values: () => ({
        onConflictDoUpdate: async () => undefined,
      }),
    }),
  } as never;
}

function fakeDeleteDb(returningRows: Array<{ tenantId: string; secretArn: string }>) {
  return {
    delete: () => ({
      where: () => ({
        returning: async () => returningRows,
      }),
    }),
  } as never;
}

const tokens = {
  accessToken: "at",
  refreshToken: "rt",
  expiresAt: new Date("2026-01-01T00:00:00Z"),
  scope: "read_items",
};

describe("saveOAuthToken's secret naming", () => {
  beforeEach(() => {
    sendMock.mockReset();
    sendMock.mockImplementation(async (command: FakeCommand) => {
      const id = command.input.SecretId ?? command.input.Name;
      return { ARN: `arn:aws:secretsmanager:us-east-2:123456789012:secret:${id}` };
    });
  });

  it("includes the env segment, tenantId, channel, and externalAccountId", async () => {
    await saveOAuthToken(fakeDb(), "tenant-a", "ebay", "12345", tokens);

    expect(sendMock).toHaveBeenCalledTimes(1);
    const sentId = (sendMock.mock.calls[0]![0] as FakeCommand).input.SecretId;
    expect(sentId).toBe("ai-ec-platform/prod/oauth/tenant-a/ebay/12345");
  });

  it("never produces the same secret name for two different tenants, even with an identical channel + externalAccountId", async () => {
    await saveOAuthToken(fakeDb(), "tenant-a", "base", "default", tokens);
    await saveOAuthToken(fakeDb(), "tenant-b", "base", "default", tokens);

    expect(sendMock).toHaveBeenCalledTimes(2);
    const [firstCommand] = sendMock.mock.calls[0]! as [FakeCommand];
    const [secondCommand] = sendMock.mock.calls[1]! as [FakeCommand];
    const firstId = firstCommand.input.SecretId;
    const secondId = secondCommand.input.SecretId;

    expect(firstId).not.toBe(secondId);
    expect(firstId).toContain("tenant-a");
    expect(secondId).toContain("tenant-b");
  });

  it("does the same for eBay, not just BASE", async () => {
    await saveOAuthToken(fakeDb(), "tenant-a", "ebay", "default", tokens);
    await saveOAuthToken(fakeDb(), "tenant-b", "ebay", "default", tokens);

    const firstId = (sendMock.mock.calls[0]![0] as FakeCommand).input.SecretId;
    const secondId = (sendMock.mock.calls[1]![0] as FakeCommand).input.SecretId;
    expect(firstId).not.toBe(secondId);
  });

  it("falls back to CreateSecretCommand (by Name, not SecretId) when the secret doesn't exist yet", async () => {
    const { ResourceNotFoundException } = await import("@aws-sdk/client-secrets-manager");
    // The mocked class (see vi.mock above) is really just `class extends Error {}`, but its
    // real (unmocked) type still requires an AWS exception options object -- cast the
    // constructor to match what's actually mocked at runtime.
    const MockedResourceNotFoundException = ResourceNotFoundException as unknown as new (message: string) => Error;
    sendMock.mockReset();
    sendMock
      .mockImplementationOnce(async () => {
        throw new MockedResourceNotFoundException("not found");
      })
      .mockImplementationOnce(async (command: FakeCommand) => ({
        ARN: `arn:aws:secretsmanager:us-east-2:123456789012:secret:${command.input.Name}`,
      }));

    await saveOAuthToken(fakeDb(), "tenant-a", "ebay", "12345", tokens);

    expect(sendMock).toHaveBeenCalledTimes(2);
    const createCommand = sendMock.mock.calls[1]![0] as FakeCommand;
    expect(createCommand.input.Name).toBe("ai-ec-platform/prod/oauth/tenant-a/ebay/12345");
  });
});

describe("deleteOAuthConnectionsForTenant", () => {
  beforeEach(() => {
    sendMock.mockReset();
    sendMock.mockResolvedValue({});
  });

  it("deletes the Secrets Manager secret for each deleted connection row and returns them", async () => {
    const rows = [{ tenantId: "tenant-a", secretArn: "arn:aws:secretsmanager:us-east-2:123456789012:secret:s1" }];
    const db = fakeDeleteDb(rows);

    const result = await deleteOAuthConnectionsForTenant(db, "tenant-a", "ebay");

    expect(result).toEqual(rows);
    expect(sendMock).toHaveBeenCalledTimes(1);
    const command = sendMock.mock.calls[0]![0] as FakeCommand;
    expect(command.input.SecretId).toBe(rows[0]!.secretArn);
    expect(command.input.ForceDeleteWithoutRecovery).toBe(true);
  });

  it("tolerates a secret that's already gone (a retried offboarding pass) instead of throwing", async () => {
    const { ResourceNotFoundException } = await import("@aws-sdk/client-secrets-manager");
    const MockedResourceNotFoundException = ResourceNotFoundException as unknown as new (message: string) => Error;
    sendMock.mockImplementationOnce(async () => {
      throw new MockedResourceNotFoundException("not found");
    });
    const db = fakeDeleteDb([{ tenantId: "tenant-a", secretArn: "arn:...:s1" }]);

    await expect(deleteOAuthConnectionsForTenant(db, "tenant-a", "ebay")).resolves.toEqual([
      { tenantId: "tenant-a", secretArn: "arn:...:s1" },
    ]);
  });

  it("is a no-op when the tenant has no connection for that channel", async () => {
    const db = fakeDeleteDb([]);

    const result = await deleteOAuthConnectionsForTenant(db, "tenant-a", "ebay");

    expect(result).toEqual([]);
    expect(sendMock).not.toHaveBeenCalled();
  });
});

describe("deleteOAuthConnectionsByExternalAccount (regression: shared secret-deletion helper still applies here too)", () => {
  beforeEach(() => {
    sendMock.mockReset();
    sendMock.mockResolvedValue({});
  });

  it("deletes every connected tenant's secret for the given external account", async () => {
    const rows = [
      { tenantId: "tenant-a", secretArn: "arn:...:a" },
      { tenantId: "tenant-b", secretArn: "arn:...:b" },
    ];
    const db = fakeDeleteDb(rows);

    const result = await deleteOAuthConnectionsByExternalAccount(db, "ebay", "ebay-user-123");

    expect(result).toEqual(rows);
    expect(sendMock).toHaveBeenCalledTimes(2);
  });
});
