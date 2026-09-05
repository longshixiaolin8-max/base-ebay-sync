import { eq } from "drizzle-orm";
import type { Database } from "./client.js";
import { snsContent } from "./schema.js";

export type SnsContentRow = typeof snsContent.$inferSelect;

export async function getSnsContent(db: Database, productId: string): Promise<SnsContentRow | null> {
  const [row] = await db.select().from(snsContent).where(eq(snsContent.productId, productId)).limit(1);
  return row ?? null;
}

/** Item #6 of the commercial-features round ("SNS管理" -- AI台本生成). Stores the AI's
 *  generated script only; nothing here ever posts anything anywhere. */
export async function upsertSnsScript(
  db: Database,
  productId: string,
  scriptText: string,
  promptVersion: string,
): Promise<SnsContentRow> {
  const now = new Date();
  await db
    .insert(snsContent)
    .values({ productId, scriptText, scriptPromptVersion: promptVersion, updatedAt: now })
    .onConflictDoUpdate({
      target: snsContent.productId,
      set: { scriptText, scriptPromptVersion: promptVersion, updatedAt: now },
    });

  const [row] = await db.select().from(snsContent).where(eq(snsContent.productId, productId)).limit(1);
  if (!row) throw new Error(`sns_content row missing after upsert for product ${productId}`);
  return row;
}

export interface MarkSnsStatusInput {
  videoCreated?: boolean;
  instagramPosted?: boolean;
  tiktokPosted?: boolean;
}

/**
 * 動画作成済み/Instagram投稿済み/TikTok投稿済み (item #6). Human-confirmed flags -- there is
 * no video-generation or social-posting API integration in this stack, so this only ever
 * records that a person actually did the real-world action, matching this platform's existing
 * pattern of AI producing a draft and a human confirming reality (see ai_listing_draft's
 * needsHumanReview).
 */
export async function markSnsStatus(db: Database, productId: string, input: MarkSnsStatusInput): Promise<SnsContentRow> {
  const now = new Date();
  const patch: Partial<typeof snsContent.$inferInsert> = { updatedAt: now };
  if (input.videoCreated !== undefined) {
    patch.videoCreated = input.videoCreated;
    patch.videoCreatedAt = input.videoCreated ? now : null;
  }
  if (input.instagramPosted !== undefined) {
    patch.instagramPosted = input.instagramPosted;
    patch.instagramPostedAt = input.instagramPosted ? now : null;
  }
  if (input.tiktokPosted !== undefined) {
    patch.tiktokPosted = input.tiktokPosted;
    patch.tiktokPostedAt = input.tiktokPosted ? now : null;
  }

  await db
    .insert(snsContent)
    .values({ productId, ...patch })
    .onConflictDoUpdate({ target: snsContent.productId, set: patch });

  const [row] = await db.select().from(snsContent).where(eq(snsContent.productId, productId)).limit(1);
  if (!row) throw new Error(`sns_content row missing after upsert for product ${productId}`);
  return row;
}
