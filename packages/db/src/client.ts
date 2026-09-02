import { RDSDataClient } from "@aws-sdk/client-rds-data";
import { drizzle } from "drizzle-orm/aws-data-api/pg";
import * as schema from "./schema.js";

export interface DbConfig {
  resourceArn: string;
  secretArn: string;
  database: string;
  region?: string;
}

/**
 * Aurora Serverless v2 via the RDS Data API — chosen so Lambdas can reach Postgres over
 * HTTPS without a VPC/ENI cold-start tax or NAT gateway cost.
 */
export function createDbClient(config: DbConfig) {
  const client = new RDSDataClient({ region: config.region });
  return drizzle(client, {
    database: config.database,
    secretArn: config.secretArn,
    resourceArn: config.resourceArn,
    schema,
  });
}

export type Database = ReturnType<typeof createDbClient>;
export * from "./schema.js";
