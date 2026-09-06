import * as cdk from "aws-cdk-lib";
import * as amplify from "aws-cdk-lib/aws-amplify";
import type { Construct } from "constructs";

export interface AdminHostingStackProps extends cdk.StackProps {
  envName: string;
}

/**
 * Hosts apps/admin as a plain static export (see apps/admin/next.config.mjs -- every page
 * is a client component fetching its own data at request time, so nothing needs Next's
 * server runtime). Deployed in Amplify Hosting's *manual* mode: no Git repository is
 * connected, and no build runs on Amplify's side -- `aws amplify create-deployment` /
 * `start-deployment` upload the already-built `apps/admin/out/` directory directly, the
 * same "drag and drop a zip" flow Amplify's own console offers, just scripted. This avoids
 * needing an interactive GitHub App OAuth consent (which isn't scriptable at all) just to
 * get a real hosted URL online.
 *
 * NEXT_PUBLIC_* values are compiled into the static JS bundle at build time (see
 * apps/admin/.env.local, gitignored) -- there is no Amplify-side build step here for a
 * CfnApp environment variable to feed into, so none is set on this construct.
 */
export class AdminHostingStack extends cdk.Stack {
  readonly appId: string;
  readonly branchName = "deploy";
  /** The real hosted origin, e.g. https://deploy.<appId>.amplifyapp.com -- a CDK token
   *  (resolved at deploy time), consumed by ApiCoreStack to tighten CORS away from the
   *  wildcard fallback once a real origin exists to restrict to. */
  readonly url: string;

  constructor(scope: Construct, id: string, props: AdminHostingStackProps) {
    super(scope, id, props);

    const app = new amplify.CfnApp(this, "AdminApp", {
      name: `ai-ec-platform-admin-${props.envName}`,
      // Client-side routes only (no route params) -- a direct request for e.g. /commerce
      // resolves to /commerce/index.html natively (trailingSlash: true in next.config.mjs),
      // so no SPA-style catch-all rewrite is needed; only a 404 fallback for unknown paths.
      customRules: [
        { source: "/<*>", target: "/404/index.html", status: "404" },
      ],
    });

    new amplify.CfnBranch(this, "DeployBranch", {
      appId: app.attrAppId,
      branchName: this.branchName,
      enableAutoBuild: false,
      stage: props.envName === "prod" ? "PRODUCTION" : "DEVELOPMENT",
    });

    this.appId = app.attrAppId;
    this.url = `https://${this.branchName}.${app.attrAppId}.amplifyapp.com`;

    new cdk.CfnOutput(this, "AdminAppId", { value: app.attrAppId });
    new cdk.CfnOutput(this, "AdminUrl", { value: this.url });
  }
}
