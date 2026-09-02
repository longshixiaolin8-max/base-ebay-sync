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

export { requireEnv };
