import * as cdk from "aws-cdk-lib";
import * as s3 from "aws-cdk-lib/aws-s3";
import type { Construct } from "constructs";
import type { PlatformConfig } from "./config.js";

export class StorageStack extends cdk.Stack {
  readonly productImagesBucket: s3.Bucket;

  constructor(scope: Construct, id: string, config: PlatformConfig, props?: cdk.StackProps) {
    super(scope, id, props);

    this.productImagesBucket = new s3.Bucket(this, "ProductImagesBucket", {
      encryption: s3.BucketEncryption.S3_MANAGED,
      blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
      versioned: true,
      lifecycleRules: [{ noncurrentVersionExpiration: cdk.Duration.days(90) }],
      removalPolicy: config.envName === "prod" ? cdk.RemovalPolicy.RETAIN : cdk.RemovalPolicy.DESTROY,
      autoDeleteObjects: config.envName !== "prod",
    });
  }
}
