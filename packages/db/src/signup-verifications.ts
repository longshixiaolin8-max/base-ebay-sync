import { and, eq, gt, lt, sql } from "drizzle-orm";
import type { Database } from "./client.js";
import { signupVerifications } from "./schema.js";

export interface SignupVerification {
  email: string;
  codeHash: string;
  expiresAt: Date;
  attempts: number;
  resendAvailableAt: Date;
}

export async function getSignupVerification(db: Database, email: string): Promise<SignupVerification | undefined> {
  const [row] = await db
    .select({
      email: signupVerifications.email,
      codeHash: signupVerifications.codeHash,
      expiresAt: signupVerifications.expiresAt,
      attempts: signupVerifications.attempts,
      resendAvailableAt: signupVerifications.resendAvailableAt,
    })
    .from(signupVerifications)
    .where(eq(signupVerifications.email, email))
    .limit(1);
  return row;
}

export async function upsertSignupVerification(
  db: Database,
  input: { email: string; codeHash: string; expiresAt: Date; resendAvailableAt: Date },
): Promise<void> {
  const now = new Date();
  await db
    .insert(signupVerifications)
    .values({
      ...input,
      attempts: 0,
      createdAt: now,
      updatedAt: now,
    })
    .onConflictDoUpdate({
      target: signupVerifications.email,
      set: {
        codeHash: input.codeHash,
        expiresAt: input.expiresAt,
        resendAvailableAt: input.resendAvailableAt,
        attempts: 0,
        updatedAt: now,
      },
    });
}

export async function incrementSignupVerificationAttempt(db: Database, email: string): Promise<void> {
  await db
    .update(signupVerifications)
    .set({ attempts: sql`${signupVerifications.attempts} + 1`, updatedAt: new Date() })
    .where(eq(signupVerifications.email, email));
}

/**
 * Atomic claim: only one concurrent confirmation can consume a valid challenge. A failed
 * code never deletes anything; callers increment attempts separately.
 */
export async function claimSignupVerification(
  db: Database,
  input: { email: string; codeHash: string; now?: Date; maxAttempts?: number },
): Promise<boolean> {
  const now = input.now ?? new Date();
  const maxAttempts = input.maxAttempts ?? 5;
  const rows = await db
    .delete(signupVerifications)
    .where(
      and(
        eq(signupVerifications.email, input.email),
        eq(signupVerifications.codeHash, input.codeHash),
        gt(signupVerifications.expiresAt, now),
        lt(signupVerifications.attempts, maxAttempts),
      ),
    )
    .returning({ email: signupVerifications.email });
  return rows.length === 1;
}

export async function deleteSignupVerification(db: Database, email: string): Promise<void> {
  await db.delete(signupVerifications).where(eq(signupVerifications.email, email));
}
