# @ai-ec/adapter-shopify

This is Shopify wired up as this platform's 3rd real sales channel, alongside BASE and
eBay — not a hand-off scaffold anymore. It implements `ChannelAdapter` (`@ai-ec/core`)
against Shopify's publicly documented Admin REST API, following the same file layout as
`@ai-ec/adapter-base` and `@ai-ec/adapter-ebay` (`config.ts`, `client.ts`, `client.test.ts`,
`index.ts`). It compiles, typechecks, and its unit tests pass against mocked HTTP responses.

**Per-tenant shop domain.** Unlike BASE/eBay, every Shopify API call is scoped to one
store's own subdomain, which doesn't fit `loadImplementedChannelAdapters()`'s one-shared-
instance-per-channel pattern. Resolved by compositing the shop domain into `externalId`
itself (`"{shopDomain}::{productId}"`, parsed back out internally) for every per-product
method; `ShopifyAdapterConfig.shopDomain` stays optional and is only set on a per-request
instance built fresh in `oauth-shopify` (OAuth) and `shopify-sync-worker` (`createListing`),
where the domain is already known from context. See `ShopifyAdapter`'s own class doc
comment in `client.ts` for the full design.

**Known, deliberate V1 limitation: push-only.** `listProducts`/`listRecentSales` have no
`externalId` to carry a shop domain in, and this platform's real pipeline never calls them
for a destination-only channel today (BASE is the only channel products/sales are ever read
FROM). They throw a clear error on the shared shop-less instance. In practice this makes
Shopify a **push-only** channel in V1: it receives inventory decrements from BASE/eBay sales
and can have new listings published to it, but a sale made directly on the tenant's own
Shopify storefront is **not** detected or cross-decremented against BASE/eBay stock. Fixing
that for real needs a broader interface change (threading a per-tenant identifier through
`listRecentSales`), tracked in `docs/adding-a-channel.md`.

**Other known simplifications**, documented inline in `client.ts`: `defaultLocationId` is
resolved dynamically (this store's first location via `GET /locations.json`) rather than
configured, correct for the common single-location store and wrong for a multi-warehouse
Shopify setup; `priceJpy`/sale-price fields pass a Shopify store's native currency straight
through rather than converting, since Shopify is a destination channel like eBay, not a
source this platform reads FROM.

What it is **not**: it has never been run against a real Shopify store or Partner app — this
environment has no Shopify test credentials to verify against. Every endpoint path, field
name, and header (`X-Shopify-Access-Token`, the OAuth token/scope shapes, the
inventory-per-location model) was written from Shopify's public docs, the same way BASE's own
`client.ts` was originally written before being checked against a live BASE account. Before
using this for anything real:

1. Verify every request/response shape in `client.ts` against Shopify's current Admin API
   reference (shopify.dev) and a real test store.
2. Add real Shopify app credentials to Secrets Manager (`infra/lib/secrets-stack.ts`'s
   `shopifyAppCredentials` secret) and a real Shopify Partner app's client id/secret.
