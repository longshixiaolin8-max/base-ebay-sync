import { createDbClient, createDbIdempotencyStore, type Database } from "@ai-ec/db";
import { getDbConfig } from "./env.js";

let cachedDb: Database | undefined;

/** Reuses the client across warm Lambda invocations (RDS Data API is stateless HTTPS, no
 *  connection pooling concerns like a raw TCP driver would have). */
export function getDb(): Database {
  if (!cachedDb) {
    cachedDb = createDbClient(getDbConfig());
  }
  return cachedDb;
}

export function getIdempotencyStore() {
  return createDbIdempotencyStore(getDb());
}
