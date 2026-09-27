import { describe, expect, it, vi } from "vitest";

const executeMock = vi.fn().mockResolvedValue(undefined);
const dbMock = { execute: executeMock };
const getDbMock = vi.fn(() => dbMock);

vi.mock("@ai-ec/lambda-shared", () => ({
  getDb: () => getDbMock(),
}));

const migrateMock = vi.fn().mockResolvedValue(undefined);
vi.mock("drizzle-orm/aws-data-api/pg/migrator", () => ({
  migrate: (...args: unknown[]) => migrateMock(...args),
}));

const { handler } = await import("./handler.js");

describe("db-migrate handler", () => {
  it("runs pending migrations then seeds the bootstrap tenant idempotently", async () => {
    const result = await handler();

    expect(migrateMock).toHaveBeenCalledTimes(1);
    expect(migrateMock.mock.calls[0]?.[0]).toBe(dbMock);
    expect(migrateMock.mock.calls[0]?.[1]).toMatchObject({
      migrationsFolder: expect.stringContaining("migrations"),
    });

    expect(executeMock).toHaveBeenCalledTimes(1);
    const [queryArg] = executeMock.mock.calls[0]!;
    const queryChunks = (queryArg as { queryChunks: Array<{ value?: string[] } | string> }).queryChunks;
    const queryText = queryChunks.map((chunk) => (typeof chunk === "string" ? chunk : (chunk.value ?? []).join(""))).join("<param>");
    expect(queryText).toContain("INSERT INTO");
    expect(queryText).toContain("tenants");
    expect(queryText).toContain("ON CONFLICT");

    expect(result).toEqual({ bootstrapTenantId: "00000000-0000-0000-0000-000000000001" });
  });

  it("runs migrations before seeding the tenant, not the other way around", async () => {
    const callOrder: string[] = [];
    migrateMock.mockImplementationOnce(async () => {
      callOrder.push("migrate");
    });
    executeMock.mockImplementationOnce(async () => {
      callOrder.push("seed");
    });

    await handler();

    expect(callOrder).toEqual(["migrate", "seed"]);
  });
});
