function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`Missing required environment variable: ${name}`);
  return value;
}

export function getDbConfig() {
  return {
    resourceArn: requireEnv("DB_CLUSTER_ARN"),
    secretArn: requireEnv("DB_SECRET_ARN"),
    database: requireEnv("DB_NAME"),
    region: process.env.AWS_REGION,
  };
}

export function getQueueUrls() {
  return {
    aiGenerate: requireEnv("AI_GENERATE_QUEUE_URL"),
    ebaySync: requireEnv("EBAY_SYNC_QUEUE_URL"),
    inventorySync: requireEnv("INVENTORY_SYNC_QUEUE_URL"),
  };
}

/** Same env var names dlq-redrive already reads (see services/lambdas/dlq-redrive) --
 *  reused here so admin-api's SLO endpoint can report live DLQ depth. */
export function getDlqUrls() {
  return {
    aiGenerate: requireEnv("AI_GENERATE_DLQ_URL"),
    ebaySync: requireEnv("EBAY_SYNC_DLQ_URL"),
    inventorySync: requireEnv("INVENTORY_SYNC_DLQ_URL"),
  };
}

export { requireEnv };
