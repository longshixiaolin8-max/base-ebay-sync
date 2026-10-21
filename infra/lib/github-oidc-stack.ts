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

    const [githubOwner, githubRepoName] = props.githubRepo.split("/");

    this.deployRole = new iam.Role(this, "GithubDeployRole", {
      roleName: "ai-ec-platform-github-deploy",
      assumedBy: new iam.WebIdentityPrincipal(provider.openIdConnectProviderArn, {
        StringEquals: { "token.actions.githubusercontent.com:aud": "sts.amazonaws.com" },
        // Restrict to this repo; further restrict `ref:refs/heads/main` once the deploy
        // workflow only ever runs against main behind the required manual-approval gate.
        //
        // Two accepted `sub` shapes: the classic "repo:owner/repo:*" and the newer
        // "repo:owner@orgId/repo@repoId:*" that GitHub sends once an org/repo has immutable
        // IDs enabled in its OIDC subject claim (confirmed live via CloudTrail: this account
        // sends the immutable-ID form, which the classic-only pattern silently rejected with
        // "Not authorized to perform sts:AssumeRoleWithWebIdentity").
        StringLike: {
          "token.actions.githubusercontent.com:sub": [
            `repo:${props.githubRepo}:environment:dev`,
            `repo:${props.githubRepo}:environment:prod`,
            `repo:${githubOwner}@*/${githubRepoName}@*:environment:dev`,
            `repo:${githubOwner}@*/${githubRepoName}@*:environment:prod`,
          ],
        },
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

    // Round 15 hardening ("DB migrationをdeployに統合"): deploy.yml's own post-deploy
    // steps (invoking DbMigrate, then the smoke test) call these two APIs directly with
    // this role's own credentials -- `cdk deploy` above never needed them itself, since it
    // only ever assumes the cdk-* bootstrap roles for that. Scoped to this app's own
    // stacks/functions (every environment's, via the shared "AiEcPlatform-" prefix), not a
    // blanket lambda:*/cloudformation:* grant.
    //
    // IMPORTANT: this stack is the one-time, human-run bootstrap (see this file's own top
    // comment) -- adding this policy in source does NOT reach the live IAM role by itself.
    // Re-run the same one-time command (`cdk deploy <stackPrefix>-GithubOidc --context
    // bootstrapOidc=true --context githubRepo=...`) once, locally, with your own AWS
    // credentials, or every deploy.yml run's new "Run DB migration"/"Post-deploy smoke
    // test" steps will fail with AccessDenied.
    this.deployRole.addToPolicy(
      new iam.PolicyStatement({
        sid: "InvokeDbMigrateAndDescribeStacks",
        actions: ["lambda:InvokeFunction", "cloudformation:DescribeStacks"],
        resources: [
          `arn:aws:lambda:*:${this.account}:function:AiEcPlatform-*`,
          `arn:aws:cloudformation:*:${this.account}:stack/AiEcPlatform-*/*`,
        ],
      }),
    );

    // The normal deploy workflow now publishes apps/admin/out to the existing manual-mode
    // Amplify Hosting app after backend/CDK validation. These are data-plane deployment
    // calls made directly by the GitHub OIDC role, so they are intentionally separate from
    // the CDK bootstrap-role permissions above.
    this.deployRole.addToPolicy(
      new iam.PolicyStatement({
        sid: "PublishAdminFrontend",
        actions: ["amplify:CreateDeployment", "amplify:StartDeployment", "amplify:GetJob"],
        resources: [`arn:aws:amplify:*:${this.account}:apps/*`],
      }),
    );

    // deploy.yml's "Production public-SaaS configuration preflight" step (prod only) calls
    // these AWS CLI commands directly with this same role's credentials -- it's a plain
    // bash script, never routed through the CDK bootstrap roles above -- to confirm Stripe
    // is live-mode, BASE/eBay OAuth app credentials are complete, and SES production access
    // + the sender identity are verified, before ever building/shipping the public frontend.
    // Read-only, and scoped to this app's own secret-name prefix (never a blanket
    // secretsmanager:* grant) -- covers both dev's flat "ai-ec-platform/app-credentials/*"
    // and prod's "ai-ec-platform/prod/app-credentials/*" naming.
    this.deployRole.addToPolicy(
      new iam.PolicyStatement({
        sid: "ReadAppCredentialSecretsForPreflight",
        actions: ["secretsmanager:GetSecretValue"],
        resources: [
          `arn:aws:secretsmanager:*:${this.account}:secret:ai-ec-platform/app-credentials/*`,
          `arn:aws:secretsmanager:*:${this.account}:secret:ai-ec-platform/*/app-credentials/*`,
        ],
      }),
    );
    this.deployRole.addToPolicy(
      new iam.PolicyStatement({
        sid: "ReadSesStatusForPreflight",
        // The CLI calls these as `aws sesv2 ...`, but IAM kept both operations under the
        // original "ses:" action namespace rather than a separate "sesv2:" one -- confirmed
        // live after "sesv2:GetAccount" was rejected with AccessDenied even though it was
        // granted. GetAccount has no resource-level permissions (SES requires "*");
        // GetEmailIdentity is scoped to the identity ARNs this platform could ever configure
        // as SES_FROM_EMAIL.
        actions: ["ses:GetAccount"],
        resources: ["*"],
      }),
    );
    this.deployRole.addToPolicy(
      new iam.PolicyStatement({
        sid: "ReadSesIdentityForPreflight",
        actions: ["ses:GetEmailIdentity"],
        resources: [`arn:aws:ses:*:${this.account}:identity/*`],
      }),
    );
  }
}
