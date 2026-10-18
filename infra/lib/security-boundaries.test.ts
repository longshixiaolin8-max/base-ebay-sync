import * as cdk from "aws-cdk-lib";
import { Template } from "aws-cdk-lib/assertions";
import { describe, expect, it } from "vitest";
import { AuthStack } from "./auth-stack.js";
import { AdminHostingStack } from "./admin-hosting-stack.js";
import { GithubOidcStack } from "./github-oidc-stack.js";
import type { PlatformConfig } from "./config.js";

describe("AWS security boundaries", () => {
  it("sets security response headers on the actual Amplify static app host", () => {
    const app = new cdk.App();
    const stack = new AdminHostingStack(app, "TestAdminHosting", {
      envName: "dev",
      env: { account: "111111111111", region: "us-east-2" },
    });
    const resource = Object.values(Template.fromStack(stack).findResources("AWS::Amplify::App"))[0] as {
      Properties: { CustomHeaders: string };
    };
    expect(resource.Properties.CustomHeaders).toContain("Strict-Transport-Security");
    expect(resource.Properties.CustomHeaders).toContain("X-Content-Type-Options");
    expect(resource.Properties.CustomHeaders).toContain("frame-ancestors 'none'");
    expect(resource.Properties.CustomHeaders).toContain("object-src 'none'");
  });

  it("allows public app-client tenant claims to be read but not rewritten", () => {
    const app = new cdk.App();
    const stack = new AuthStack(app, "TestAuth", { envName: "dev" } as PlatformConfig,
      { env: { account: "111111111111", region: "us-east-2" } });
    const client = Object.values(Template.fromStack(stack).findResources("AWS::Cognito::UserPoolClient"))[0] as {
      Properties: { ReadAttributes: string[]; WriteAttributes: string[] };
    };
    expect(client.Properties.ReadAttributes).toContain("custom:tenant_id");
    // No self-service attribute writes at all: nothing in the frontend calls
    // updateUserAttributes, and "name" was never part of this pool's own schema
    // (only "email" is declared in AuthStack's standardAttributes), so granting
    // write access to it isn't just unnecessary -- Cognito rejects it outright.
    expect(client.Properties.WriteAttributes).toEqual([]);
  });

  it("rejects OIDC subjects outside reviewed dev/prod environments", () => {
    const app = new cdk.App();
    const stack = new GithubOidcStack(app, "TestOidc", { githubRepo: "owner/repo" },
      { env: { account: "111111111111", region: "us-east-2" } });
    const roles = Template.fromStack(stack).findResources("AWS::IAM::Role");
    const role = Object.values(roles).find((resource) =>
      (resource as { Properties?: { RoleName?: string } }).Properties?.RoleName === "ai-ec-platform-github-deploy",
    ) as {
      Properties: { AssumeRolePolicyDocument: { Statement: Array<{ Condition?: { StringLike?: Record<string, string[]> } }> } };
    } | undefined;
    expect(role).toBeDefined();
    const subjects = role!.Properties.AssumeRolePolicyDocument.Statement.flatMap(
      s => s.Condition?.StringLike?.["token.actions.githubusercontent.com:sub"] ?? [],
    );
    expect(subjects).toHaveLength(4);
    expect(subjects).toContain("repo:owner/repo:environment:prod");
    expect(subjects).toContain("repo:owner/repo:environment:dev");
    expect(subjects.every(s => s.endsWith(":environment:prod") || s.endsWith(":environment:dev"))).toBe(true);
  });
});
