import * as cdk from "aws-cdk-lib";
import * as iam from "aws-cdk-lib/aws-iam";
import type { Construct } from "constructs";

export interface GithubOidcStackProps extends cdk.StackProps {
  /** e.g. "your-org/base-ebay-sync" */
  githubRepo: string;
}

/**
 * One-time bootstrap: lets GitHub Actions assume a deploy role via OIDC, with no long-lived
 * AWS access keys ever stored in GitHub. This stack must be deployed once by a human with
 * their own AWS credentials (chicken-and-egg: GitHub Actions can't create the role that lets
 * it authenticate) — see README "Deploying" for the one-time `cdk deploy GithubOidcStack` step.
 */
export class GithubOidcStack extends cdk.Stack {
  readonly deployRole: iam.Role;

  constructor(scope: Construct, id: string, props: GithubOidcStackProps, stackProps?: cdk.StackProps) {
    super(scope, id, stackProps);

    const provider = new iam.OpenIdConnectProvider(this, "GithubOidcProvider", {
      url: "https://token.actions.githubusercontent.com",
      clientIds: ["sts.amazonaws.com"],
    });

    this.deployRole = new iam.Role(this, "GithubDeployRole", {
      roleName: "ai-ec-platform-github-deploy",
      assumedBy: new iam.WebIdentityPrincipal(provider.openIdConnectProviderArn, {
        StringEquals: { "token.actions.githubusercontent.com:aud": "sts.amazonaws.com" },
        // Restrict to this repo; further restrict `ref:refs/heads/main` once the deploy
        // workflow only ever runs against main behind the required manual-approval gate.
        StringLike: { "token.actions.githubusercontent.com:sub": `repo:${props.githubRepo}:*` },
      }),
      description: "Assumed by GitHub Actions (OIDC) to run `cdk deploy`. No static AWS keys in GitHub.",
      maxSessionDuration: cdk.Duration.hours(1),
    });

    // CDK deploys via CloudFormation using the bootstrap deploy/file-publishing roles, so
    // the GitHub role itself only needs to assume those — not blanket account admin.
    this.deployRole.addToPolicy(
      new iam.PolicyStatement({
        sid: "AssumeCdkBootstrapRoles",
        actions: ["sts:AssumeRole"],
        resources: [`arn:aws:iam::${this.account}:role/cdk-*`],
      }),
    );
  }
}
