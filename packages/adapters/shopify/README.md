# @ai-ec/adapter-shopify

**This is a scaffold, not a production integration.** It implements `ChannelAdapter`
(`@ai-ec/core`) against Shopify's publicly documented Admin REST API, following the exact
same file layout as `@ai-ec/adapter-base` and `@ai-ec/adapter-ebay` (`config.ts`, `client.ts`,
`client.test.ts`, `index.ts`). It compiles, typechecks, and its unit tests pass against
mocked HTTP responses.

What it is **not**: it has never been run against a real Shopify store or Partner app — this
environment has no Shopify test credentials to verify against. Every endpoint path, field
name, and header (`X-Shopify-Access-Token`, the OAuth token/scope shapes, the
inventory-per-location model) was written from Shopify's public docs, the same way BASE's own
`client.ts` was originally written before being checked against a live BASE account. Before
using this for anything real:

1. Verify every request/response shape in `client.ts` against Shopify's current Admin API
   reference (shopify.dev) and a real test store.
2. Add real Shopify app credentials to Secrets Manager and provision them in
   `infra/lib/secrets-stack.ts`.
3. Add `"shopify"` to `IMPLEMENTED_CHANNELS` in `@ai-ec/core`'s `channel.ts` — **only after**
   the pipeline gaps listed in `docs/adding-a-channel.md` are actually addressed, since several
   places in this codebase (the sale-application outbox, in particular) still assume exactly
   2 implemented channels.
