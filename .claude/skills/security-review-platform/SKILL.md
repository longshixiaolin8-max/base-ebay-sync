---
name: security-review-platform
description: Security review checklist specific to this repo (base-ebay-sync) -- a multi-tenant SaaS on AWS Lambda/API Gateway/Aurora with public signup, Stripe billing, and BASE/eBay OAuth. Use when asked to review this codebase's security, audit a new route/Lambda/IAM grant before it ships, investigate a suspected vulnerability here, or do a general "security review" / "harden security" pass on this repo. Encodes real gotchas already hit in this codebase (not generic OWASP advice) -- an IAM grant that silently needed a second resource type, a DB delete that 500'd on an untested foreign key, an LLM-authored HTML field rendered unsanitized. Not for other repos or for reviewing third-party code.
---

# Security review: base-ebay-sync

This is a project-specific checklist, not generic security advice. Every item here maps to a
real pattern, convention, or past incident in this codebase. Run through it when reviewing a
diff, auditing the repo as a whole, or before shipping a new Lambda/route/IAM grant.

## 1. Tenant isolation (the #1 risk in this codebase)

Every `/admin/*` route except `/admin/billing/*` and the public `/signup`, `/webhooks/*`
endpoints must scope every DB query by the caller's own `custom:tenant_id` Cognito claim
(`tenantIdFromEvent(event)` in `services/lambdas/admin-api/src/handler.ts`). Check:

- Every `db.select()`/`.update()`/`.delete()` in a per-tenant route has `eq(table.tenantId, tenantId)`
  in its `where()` -- grep for the route, then check every query inside it individually; a route
  that joins multiple tables needs the tenant filter on **every** joined table, not just the first.
- A route taking an `{id}` path param (e.g. `/admin/products/{id}`) must still filter by the
  caller's own tenantId, not just the row's own id -- otherwise tenant A can read/mutate tenant
  B's row by guessing/enumerating ids. This is the single most common mistake to look for.
- **The one deliberate exception**: `/admin/ops/*` routes act on an operator-chosen tenantId from
  the URL path, not the caller's own claim -- by design (see `requireOperator()`'s doc comment).
  Confirm any such route is gated by `requireOperator()`, which fails closed (403) when
  `OPERATOR_EMAIL` isn't configured -- never "falls back to allow". If you add a new `/admin/ops/*`
  route, call `requireOperator()` first, before touching any data.

## 2. IAM grants: resource type, not just action

When an AWS SDK call starts failing with `AccessDenied` or a wrapped "Failed query"/"not
authorized" error despite the IAM action being granted, the actual problem has twice now been
the **resource type**, not the action:

- SES `SendEmail` needs both `identity/*` **and** `configuration-set/*` resources when the account
  has a default configuration set attached (confirmed live, see `lambda-stack.ts`'s comment on
  `SignupHandler`'s SES grant) -- `identity/*` alone 403s.
- When adding any new `cognito-idp:*`, `ses:*`, `secretsmanager:*`, etc. grant, check whether the
  action's docs list resource-level permissions, and scope to the actual ARN pattern this account
  uses (see `github-oidc-stack.ts`'s own comments for the existing narrow-grant precedent) --
  never a blanket `*` resource unless the action truly has no resource-level permissions (SES
  `GetAccount` is the one confirmed example of that).
- After adding an IAM grant, don't assume it's live just because `cdk synth` succeeds -- CDK diffs
  by resource change, so a Lambda whose code didn't change may not get its new policy statement
  attached on this deploy if something else already triggered a no-op for that stack. Verify with
  a real invoke against the deployed function, not just synth, for anything security-relevant.

## 3. Deleting a row: check every FK pointing at it first

`audit_log.tenant_id` (and potentially other tables) reference `tenants.id` with **no**
`ON DELETE CASCADE`. Any new code that deletes a `tenants` row (or any other row with inbound FK
references) must either:
- Delete the referencing rows first (see `DELETE /admin/ops/tenants/{id}` in `admin-api/src/handler.ts`
  for the pattern: clear `audit_log` rows for that tenant, delete the tenant, then record the
  deletion's own audit entry with `tenantId: null` since the tenant no longer exists to reference), or
- Confirm the schema actually has cascade delete for that specific relationship (`packages/db/src/schema.ts`)
  before assuming a bare `db.delete()` is safe.

This class of bug won't surface in unit tests (mocked DB), only against a tenant that has real
history -- test the happy path against a row that actually has related data, not just an empty one.

## 4. Public (unauthenticated) endpoints

`requireCloudFrontOrigin()` gates direct API Gateway access when `CLOUDFRONT_SHARED_SECRET` is
set (currently unset in prod -- `apiEntrypoint: "direct"`, see `infra/lib/config.ts`'s own
comment on why). Any new public route (reachable without a Cognito JWT) must still:

- Validate and bound every field in the request body before any DB/SES/Stripe call (see
  `services/lambdas/signup/src/handler.ts`'s `validEmail`/`validSignupPassword`/body-size checks
  for the existing pattern) -- a public endpoint is adversarial input by definition.
- Never create a durable row (Cognito user, tenant, Stripe customer) before proving some form of
  ownership/verification first, the way `/signup` only persists anything after the OTP is
  confirmed.
- Rate-limit or otherwise bound anything that triggers a real external side effect (SES send,
  Stripe API call) per caller -- `/signup`'s OTP resend cooldown (`OTP_RESEND_COOLDOWN_MS`) and
  max-attempts lockout (`OTP_MAX_ATTEMPTS`) are the existing pattern to match for any new
  public-facing mutation.

## 5. Webhook signature verification

Every inbound webhook (Stripe, eBay platform notifications) must verify its signature **before**
touching the DB or treating the payload as trusted, and must log-and-ignore (never 500, never
retry-loop) on a bad signature. Check any new webhook handler follows
`services/lambdas/stripe-webhook/src/handler.ts`'s pattern exactly; don't trust a payload's own
claimed identity (`tenantId`, etc.) without the signature having verified first.

## 6. Rendering AI/LLM-authored or tenant-controlled HTML

`aiListingDraft.descriptionHtmlEn` is literal HTML text written by an LLM, prompted from BASE
product data a tenant controls (see `packages/ai/src/prompt.ts`) -- an indirect prompt injection
in that source data can make the model emit markup the operator's own browser will execute.
**Never** add a new `dangerouslySetInnerHTML` call anywhere in `apps/admin` without routing the
value through `apps/admin/lib/sanitize-html.ts`'s `sanitizeDraftHtml()` first (or an equivalent
DOMPurify call with an explicit allowlist) -- this was a real unpatched stored-XSS path in this
app until it was found. The same caution applies to any other point where tenant-controlled or
model-generated text is rendered as markup rather than as plain text.

## 7. Secrets and credentials

- Every Stripe/BASE/eBay/OpenAI credential lives in Secrets Manager under
  `ai-ec-platform/*/app-credentials/*`, read via `getAppCredentials()` -- never hardcode, never
  log the full object (`console.error`/`console.log` calls should log `.message`, not the error
  object or the credential itself).
- `assertLiveBillingInProd()` in `signup.ts` is the existing pattern for "fail closed in prod if a
  credential still looks like a test/placeholder value" -- apply the same fail-closed instinct to
  any new prod-only credential check, never fail open.
- `NEXT_PUBLIC_*` env vars are baked into the public static export and are **not secret** --
  confirm nothing sensitive (personal legal info, internal URLs, credentials) is ever assigned to
  one; see the git history around "特商法：開示請求方式への切替と公開ビルドの個人情報保護" for the
  real incident this guards against.

## 8. Dependency vulnerabilities

Run `pnpm audit` at the repo root periodically. When triaging a finding:

- Check whether the vulnerable package is actually in the **production** path (deployed Lambda
  bundle or the static Next.js export) versus purely a dev/test-tooling dependency (vitest, eslint,
  and everything transitively under them never ship) -- severity in isolation is misleading without
  this context.
- A version range in an advisory can be broader than the actual affected code (confirmed: a `zod`
  advisory's stated range technically covered this repo's v3 pin, but the described vulnerable
  internals -- `$ZodArray` -- are v4-only API surface that doesn't exist in v3). Read the advisory's
  actual technical description, not just the version range, before forcing a major-version bump.
- For a finding that *is* in the production path with a non-breaking patched version available
  within the same major (like the Next.js Image Optimization RCE fixed in a 15.5.x patch release),
  just take the patch -- don't rationalize it away. Note: `apps/admin` is `output: "export"` (static,
  no Next.js server runtime in production), so any Next.js *server-side* API vulnerability needs a
  second check -- does the vulnerable code path even run in this deployment shape? -- before deciding
  real-world exploitability, in addition to still patching it.
