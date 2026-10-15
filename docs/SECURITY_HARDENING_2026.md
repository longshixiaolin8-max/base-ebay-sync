# Security hardening, BASE × eBay Sync — 2026-10-15

## Confirmed code issues and fixes (not deployed)
- **Critical potential tenant escape**: The Cognito user-pool `custom:tenant_id` is mutable and the app client had implicit write permissions. Since JWT `custom:tenant_id` controls admin tenant access, a user could potentially change it using UpdateUserAttributes. Configure explicit `readAttributes` (including tenant_id), `writeAttributes` (name only). Existing pool schemas cannot be safely changed in-place. Check ALL other app clients and existing Cognito user attributes.
- **Invalid eBay destination token**: valid signed eBay REST events with bad destination token previously fell back to bootstrap tenant. Reject 403 instead (also for ownership challenge). Only a legacy tokenless endpoint uses bootstrap tenant. Plan retirement of legacy endpoint after eBay-side callback migration.
- **GitHub OIDC wildcard**: AWS role previously accepted any GitHub workflow/reference in the repo. Constrain the trust policy to dev/prod environment subjects (including immutable repo identifiers). Block production deploy jobs unless the source ref is main. Required reviewers and deployment branch rules must still be configured for prod in GitHub.
- **Token validation**: bound signed webhook token size, character set, segment count and tenant field type.

## Real deployment and test requirements
1. Back up Cognito app client configuration, webhook registrations and IAM trust. Get production change authorization. Deploy Auth and verify end-user UpdateUserAttributes cannot mutate tenant_id; inspect active sessions and other app clients. The original user pool `mutable: true` remains because Cognito schema changes are not straightforward in-place.
2. Deploy eBay webhook; verify signed legacy/per-tenant delivery succeeds while invalid token and missing eBay signature are rejected without queuing work.
3. The GitHub OIDC stack is a human bootstrap stack: this source change does not alter live AWS. Operator must redeploy separately. Validate OIDC subjects in CloudTrail, GitHub Environment reviewer and branch rules. A failing trust test means do NOT widen the wildcard.
4. Migrate API entrypoint from direct execute-api to CloudFront+WAF through a separately approved runbook adjusting BASE OAuth, Stripe webhook, eBay destinations and frontend URLs. Direct API still bypasses WAF until then.
5. Perform 2-tenant BOLA tests across products, orders, exports, OAuth, admin ops, webhook routing, worker queues; integrate deterministic denial metrics, GuardDuty, CloudTrail, Security Hub and backup/restore drills only after budget review.
6. Fix BASE stock-only quantity reconciliation P0 (Issue #24). Do not take public paying users before actual eBay seller privileges, SES production status, Stripe lifecycle, and inventory E2E are verified.

## AI security copilot plan (NOT yet implemented)
Send redacted and aggregated CloudWatch/WAF/CloudTrail/dependency advisories to a Bedrock model for **explanatory triage** with source timestamps. Never send raw secrets, tokens or customer PII. Detect using rules first, measure false positives and alert latency; AI outputs are untrusted suggestions only. AI must never auto-grant IAM permissions, deploy production, block paying customers or alter Stripe. Validate model outputs with a strict schema, audit human approvals, cap per-incident inference costs. Treat untrusted product text and external APIs as prompt injection surfaces.

Primary references: https://www.ipa.go.jp/security/10threats/10threats2026.html ; https://docs.aws.amazon.com/cognito/latest/developerguide/user-pool-settings-attributes.html ; https://docs.github.com/en/actions/how-tos/secure-your-work/security-harden-deployments/oidc-in-aws ; https://api-security.owasp.org/editions/2023/en/0xa1-broken-object-level-authorization/
