import { readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const migrationsDir = fileURLToPath(new URL("../migrations/", import.meta.url));

describe("legacy migration replay safety", () => {
  it("keeps hand-applied legacy migrations safe to replay through Drizzle", () => {
    const legacyFiles = readdirSync(migrationsDir)
      .filter((name) => /^00(?:0[1-9]|1[0-8])_.*\.sql$/.test(name))
      .sort();

    expect(legacyFiles).toHaveLength(18);

    for (const file of legacyFiles) {
      const sql = readFileSync(new URL(`../migrations/${file}`, import.meta.url), "utf8");

      // Older dev/prod environments had these DDL changes applied manually before the
      // automated DbMigrate Lambda existed. If Drizzle's migration ledger is missing a row
      // for one of those changes, replaying the file must converge instead of failing on an
      // already-present column/constraint and blocking every later migration.
      expect(sql, `${file} contains a non-idempotent ADD COLUMN`).not.toMatch(/ADD COLUMN\s+"/);
      expect(sql, `${file} contains a non-idempotent DROP CONSTRAINT`).not.toMatch(/DROP CONSTRAINT\s+"/);
    }
  });
});
