import { describe, expect, it } from "vitest";
import type { Database } from "./client.js";
import { getSnsContent, markSnsStatus, upsertSnsScript } from "./sns-content.js";

describe("getSnsContent", () => {
  it("returns null when no row exists", async () => {
    const db = { select: () => ({ from: () => ({ where: () => ({ limit: async () => [] }) }) }) } as unknown as Database;
    expect(await getSnsContent(db, "product-1")).toBeNull();
  });
});

describe("upsertSnsScript", () => {
  it("writes the script and reads the row back", async () => {
    let upserted: Record<string, unknown> | undefined;
    const db = {
      insert: () => ({
        values: (v: Record<string, unknown>) => {
          upserted = v;
          return { onConflictDoUpdate: async () => undefined };
        },
      }),
      select: () => ({
        from: () => ({ where: () => ({ limit: async () => [{ productId: "product-1", ...upserted }] }) }),
      }),
    } as unknown as Database;

    const row = await upsertSnsScript(db, "product-1", "script text", "v1");

    expect(row.scriptText).toBe("script text");
    expect(row.scriptPromptVersion).toBe("v1");
  });
});

describe("markSnsStatus", () => {
  it("stamps a timestamp when a flag is set true, and clears it when set false", async () => {
    let upserted: Record<string, unknown> | undefined;
    const db = {
      insert: () => ({
        values: (v: Record<string, unknown>) => {
          upserted = v;
          return { onConflictDoUpdate: async () => undefined };
        },
      }),
      select: () => ({
        from: () => ({ where: () => ({ limit: async () => [{ productId: "product-1", ...upserted }] }) }),
      }),
    } as unknown as Database;

    const marked = await markSnsStatus(db, "product-1", { videoCreated: true });
    expect(marked.videoCreated).toBe(true);
    expect(marked.videoCreatedAt).toBeInstanceOf(Date);

    const unmarked = await markSnsStatus(db, "product-1", { instagramPosted: false });
    expect(unmarked.instagramPosted).toBe(false);
    expect(unmarked.instagramPostedAt).toBeNull();
  });

  it("leaves fields not mentioned in the input untouched in the write patch", async () => {
    let capturedPatch: Record<string, unknown> | undefined;
    const db = {
      insert: () => ({
        values: (v: Record<string, unknown>) => {
          capturedPatch = v;
          return { onConflictDoUpdate: async () => undefined };
        },
      }),
      select: () => ({ from: () => ({ where: () => ({ limit: async () => [{ productId: "product-1" }] }) }) }),
    } as unknown as Database;

    await markSnsStatus(db, "product-1", { tiktokPosted: true });

    expect(capturedPatch).not.toHaveProperty("videoCreated");
    expect(capturedPatch).not.toHaveProperty("instagramPosted");
    expect(capturedPatch?.tiktokPosted).toBe(true);
  });
});
