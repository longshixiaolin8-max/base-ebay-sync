import * as cdk from "aws-cdk-lib";
import { Template } from "aws-cdk-lib/assertions";
import { describe, expect, it } from "vitest";
import { AuthStack } from "./auth-stack.js";
import { GithubOidcStack } from "./github-oidc-stack.js";
import type { PlatformConfig } from "./config.js";

describe("AWS security boundaries", () => {
  it("allows public app-client tenant claims to be read but not rewritten", () => {
    const app = new cdk.App();
    const stack = new AuthStack(app, "TestAuth", { envName: "dev" } as PlatformConfig,
      { env: { account: "111111111111", region: "us-east-2" } });
    const client = Object.values(Template.fromStack(stack).findResources("AWS::Cognito::UserPoolClient"))[0] as {
      Properties: { ReadAttributes: string[]; WriteAttributes: string[] };
    };
    expect(client.Properties.ReadAttributes).toContain("custom:tenant_id");
    expect(client.Properties.WriteAttributes).toEqual(["name"]);
  });

  it("rejects OIDC subjects outside reviewed dev/prod environments", () => {
    const app = new cdk.App();
    const stack = new GithubOidcStack(app, "TestOidc", { githubRepo: "owner/repo" },
      { env: { account: "111111111111", region: "us-east-2" } });
    const roles = Template.fromStack(stack).findResources("AWS::IAM::Role");
    const role = Object.values(roles)[0] as {
      Properties: { AssumeRolePolicyDocument: { Statement: Array<{ Condition?: { StringLike?: Record<string, string[]> } }> } };
    };
    const subjects = role.Properties.AssumeRolePolicyDocument.Statement.flatMap(
      s => s.Condition?.StringLike?.["token.actions.githubusercontent.com:sub"] ?? [],
    );
    expect(subjects).toHaveLength(4);
    expect(subjects).toContain("repo:owner/repo:environment:prod");
    expect(subjects).toContain("repo:owner/repo:environment:dev");
    expect(subjects.every(s => s.endsWith(":environment:prod") || s.endsWith(":environment:dev"))).toBe(true);
  });
});
