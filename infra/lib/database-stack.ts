import * as cdk from "aws-cdk-lib";
import * as ec2 from "aws-cdk-lib/aws-ec2";
import * as rds from "aws-cdk-lib/aws-rds";
import type { Construct } from "constructs";
import type { PlatformConfig } from "./config.js";

export class DatabaseStack extends cdk.Stack {
  readonly cluster: rds.DatabaseCluster;
  readonly databaseName = "ai_ec_platform";

  constructor(scope: Construct, id: string, config: PlatformConfig, props?: cdk.StackProps) {
    super(scope, id, props);

    // No NAT gateways: every Lambda talks to Postgres over the RDS Data API (HTTPS),
    // never a direct TCP connection, so nothing in this platform needs to sit in the VPC.
    //
    // AZs are passed explicitly (rather than via `maxAzs`, which triggers a live
    // "list AZs for this account" lookup) so `cdk synth` works in CI without AWS
    // credentials. AZ *names* like "us-east-2a" always exist in every account; the
    // physical AZ each name maps to is an AWS-side, account-specific detail that CDK
    // doesn't need to know at synth time.
    const vpc = new ec2.Vpc(this, "Vpc", {
      availabilityZones: [`${this.region}a`, `${this.region}b`],
      natGateways: 0,
      subnetConfiguration: [
        { name: "isolated", subnetType: ec2.SubnetType.PRIVATE_ISOLATED, cidrMask: 24 },
      ],
    });

    this.cluster = new rds.DatabaseCluster(this, "ProductMasterCluster", {
      engine: rds.DatabaseClusterEngine.auroraPostgres({ version: rds.AuroraPostgresEngineVersion.VER_17_9 }),
      vpc,
      vpcSubnets: { subnetType: ec2.SubnetType.PRIVATE_ISOLATED },
      writer: rds.ClusterInstance.serverlessV2("writer"),
      serverlessV2MinCapacity: 0.5,
      serverlessV2MaxCapacity: config.envName === "prod" ? 8 : 2,
      enableDataApi: true,
      defaultDatabaseName: this.databaseName,
      storageEncrypted: true,
      backup: { retention: cdk.Duration.days(config.envName === "prod" ? 14 : 3) },
      removalPolicy: config.envName === "prod" ? cdk.RemovalPolicy.SNAPSHOT : cdk.RemovalPolicy.DESTROY,
    });
  }
}
