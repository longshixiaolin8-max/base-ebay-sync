# Adding a new sales channel (Amazon, 楽天市場, Yahoo!ショッピング)

`README.md` and `packages/core/src/channel.ts`/`adapter.ts` say adding a channel is "just
implement `ChannelAdapter`". That's true for the adapter itself, but a repo-wide audit (done
alongside this doc) found several other places that still hardcode "exactly BASE and eBay".
This doc is the honest, current checklist: what's now automatic once you add a channel to
`IMPLEMENTED_CHANNELS`, and what you still have to touch by hand.

**Shopify is now a real, implemented 3rd channel** (`base`/`ebay`/`shopify` in
`IMPLEMENTED_CHANNELS`) — not just a scaffold adapter, as this doc originally described it.
It's the proof every "automatic" claim below actually held: the sale-application outbox
(Step 4, below) and the AI-draft pending-approval step both fan out to it with zero further
edits, exactly as this doc predicted before it was real. Its own known, deliberate V1 gaps
(push-only -- no Shopify-side sales polling; no per-tenant shop-domain parameter on the
shared `ChannelAdapter` interface) are documented in `packages/adapters/shopify/README.md`
and `client.ts`'s own class doc comment, not repeated here. What's below is now written from
Amazon/Rakuten/Yahoo!ショッピング's perspective -- the channels still actually missing.

## Which channel is actually worth adding next

`ChannelType` (`packages/core/src/channel.ts`) isn't "every marketplace that exists" — it's
narrowed to channels a real, existing competitor already integrates with, not a speculative
guess. Checked against 3 real Japanese EC一元管理 (multi-channel commerce sync) tools —
ネクストエンジン (Next Engine), CROSS MALL, GoQSystem:

| Channel | Why it's on the list | Adapter scaffold |
| --- | --- | --- |
| `amazon` | Every one of the 3 tools above supports it as baseline coverage. | `packages/adapters/amazon` |
| `rakuten` | Same — baseline coverage across all 3. | `packages/adapters/rakuten` |
| `yahoo_shopping` | The 3rd of Japan's "big 3" marketplaces — Amazon・楽天市場・Yahoo!ショッピング is the standard baseline every one of those tools lists, not just 2 of the 3. | none yet |
| `shopify` | Not a marketplace (it's a storefront platform like BASE itself), but real, confirmed demand exists: CROSS MALL's operator (アイル) is a certified **Shopify Experts** partner, and Next Engine ships its own dedicated Shopify sync app. | **implemented** (`packages/adapters/shopify`) |

Deliberately **not** on the list (yet): au PAYマーケット, Qoo10, メルカリShops, TikTok Shop,
ZOZOTOWN and the various fashion-vertical malls CROSS MALL also supports — these came up in
the same research pass but are a clear second tier (supported by some, not all, of the tools
checked), not the "everyone integrates with this" bar the current 4 meet. Worth revisiting if
a specific tenant actually asks for one of them, not worth speculatively building ahead of
demand.

**Amazon and Rakuten have a scaffold adapter** (`packages/adapters/{amazon,rakuten}` — see
each one's own README for real gaps found while writing it), but neither is in
`IMPLEMENTED_CHANNELS` yet. Yahoo!ショッピング has no scaffold yet either. Two things the
Amazon and Rakuten scaffolds surfaced, worth reading before picking up either:

- **Amazon**: `listProducts`/`createListing` both throw (SP-API has no single "list all my
  listings" call, and creating a listing needs Amazon's per-product-type attribute schema
  `CreateListingInput`'s flat shape can't express), and every real call needs a per-tenant
  `sellerId` that `ChannelAdapter`'s shared interface has no parameter slot for — see
  `packages/adapters/amazon/src/client.ts`'s own class doc for what that means for
  `loadImplementedChannelAdapters()`. **This is the same structural problem Shopify's own
  per-tenant `shopDomain` had, and Shopify's fix is the reference pattern to follow**: encode
  the per-tenant identifier into `externalId` itself
  (`"{sellerId}::{externalId}"`, parsed back out internally) for every method that already
  receives one, and require a per-request adapter instance (constructed with `sellerId` set)
  only for the few methods that mint a fresh `externalId` or have none to carry one in — see
  `ShopifyAdapter`'s own class doc comment in `packages/adapters/shopify/src/client.ts` for
  the full design and `services/lambdas/shared/src/shopify.ts` /
  `services/lambdas/oauth-shopify`/`services/lambdas/shopify-sync-worker` for how the shared
  singleton vs. per-request split plays out across Lambdas in practice.
- **Rakuten**: has **no OAuth redirect flow at all** — a shop's RMS license key is generated
  manually in Rakuten's merchant control panel and entered directly, not obtained via
  redirect. `getAuthorizationUrl`/`exchangeCodeForToken`/`refreshToken` all throw; connecting/
  reconnecting Rakuten needs its own UI (a license-key entry form), not the "再接続" redirect
  button `ConnectionCard`/`ConnectionsTab` use for every other channel today. Also: lower
  confidence than the other 3 scaffolds on exact API field names — RMS API 2.0 is far less
  publicly documented than Shopify's or Amazon SP-API's own docs.

## Step 0: implement the adapter

Copy `packages/adapters/shopify`'s file layout (`config.ts`, `client.ts`, `client.test.ts`,
`index.ts`) into a new `packages/adapters/<channel>` package (or start from the `amazon`/
`rakuten` scaffolds, which are further along for those two specific channels already) — it's
now a real, deployed implementation to copy from, not just a template whose own gaps were
still unverified. Whatever channel you're adding, verify every endpoint/field against that
channel's current API reference and (ideally) a real sandbox account before treating `amazon`/
`rakuten` as more than a template — see each package's own README, and
`packages/adapters/base/src/client.ts`'s comments for what "actually verified" looks like
once you've done that.

## Step 1: now automatic (as of this round's generalization)

These pick up a new channel with **zero further edits**, as long as you also do Step 2/3
below:

- **`otherChannels()`** (`packages/core/src/channel.ts`) returns every other implemented
  channel, not just "the one other channel" — genuinely N-channel safe. **Confirmed, not just
  claimed**: Shopify's own sale-fan-out and AI-draft pending-approval both exercise this today.
- **`loadImplementedChannelAdapters()`** (`services/lambdas/shared/src/channel-adapters.ts`)
  is the one place `inventory-sync-worker`, `inventory-diff-check` and `tenant-offboarding`
  build their `{channel: adapter}` map from. Add one line here for the new channel's
  credentials + adapter construction, and all three workers pick it up. If the channel needs
  a per-tenant identifier the shared `ChannelAdapter` interface has no slot for (Shopify's
  `shopDomain`, Amazon's `sellerId`), add it with that identifier left **unset** here — see
  the Amazon bullet above and `ShopifyAdapter`'s own class doc comment.
- **`services/lambdas/ai-generate-worker/src/handler.ts`**'s AI-draft step loops over
  `otherChannels(product.sourceChannel)` to insert one `pending_approval` `channel_listings`
  row per destination channel, reusing the same AI-generated English draft for all of them —
  not a per-channel content-generation step. A new channel's own "approve and publish" admin
  route (mirroring `POST /admin/products/{id}/approve-shopify-listing`) still needs writing by
  hand (Step 3) — only the pending-row creation itself is automatic.
- **`GET /admin/sync/connections`** (admin-api) loop-builds its response from
  `IMPLEMENTED_CHANNELS` — a new channel gets a `connections.<channel>` key with zero route
  changes.
- **`GET /admin/oauth/:channel/authorize-url`** and **`POST /admin/oauth/:channel/disconnect`**
  (admin-api) validate the `:channel` path segment against `IMPLEMENTED_CHANNELS` instead of a
  hardcoded `(base|ebay)` regex — a new channel is accepted by the route matcher automatically
  (the authorize-url route's *branch body* per channel is still Step 3, see below).
- **`apps/admin/lib/channel-meta.ts`**'s `CHANNEL_META`/`DISPLAYED_CHANNELS` drive
  `ConnectionCard.tsx` and `ConnectionsTab.tsx`'s connection cards — add one entry to each
  constant and a card renders with no JSX changes. Confirmed with Shopify's own entry.
  **Not** automatic: `apps/admin/app/channel-sync/page.tsx`'s own KPI tiles/`ConnectionCard`s/
  `IsolationCard` are still hand-written per channel (not array-driven off
  `DISPLAYED_CHANNELS` like `ConnectionsTab.tsx` is) — Shopify's own connection status doesn't
  show up there yet, only in Settings → 接続. Same for the onboarding wizard
  (`apps/admin/app/onboarding/page.tsx`, still a fixed 2-step BASE→eBay flow) and the
  dashboard's inline eBay-reconnect banner (`apps/admin/app/dashboard/page.tsx`) — both are
  hardcoded flows for exactly BASE/eBay, not yet extended to a 3rd channel.
- **`inventory-diff-check`** and **`tenant-offboarding`**'s own per-tenant loops already index
  into a `Partial<Record<ChannelType, ChannelAdapter>>` by whatever channel a `channel_listings`
  row says — no per-channel branching in their business logic.

## Step 2: still manual — infrastructure

None of this is safely auto-generalizable without real deployment testing against the new
channel's actual OAuth app / webhook needs:

- **Secrets Manager** (`infra/lib/secrets-stack.ts`): add a new `secretsmanager.Secret` field
  for the channel's app credentials, matching `baseAppCredentials`/`ebayAppCredentials`/
  `shopifyAppCredentials`.
- **CDK Lambdas** (`infra/lib/lambda-stack.ts`): if the channel needs its own OAuth callback
  route or webhook receiver (most will), add a new Lambda construct + route + secret grant,
  mirroring `oauthBaseCallbackFn`/`oauthEbayCallbackFn`/`oauthShopifyCallbackFn` and
  `ebaySyncWorkerFn`/`shopifySyncWorkerFn`/`ebay-webhook`. Also grant the new secret read
  access to every Lambda that calls `loadImplementedChannelAdapters()`
  (`inventorySyncWorkerFn`, `inventoryDiffCheckFn`, `tenantOffboardingFn`, `adminApiFn`) --
  easy to forget, since the TypeScript side compiles fine either way and only fails at
  runtime (`AccessDeniedException`) once that code path actually runs.
- **SQS** (`infra/lib/queue-stack.ts`): if the channel needs an async publish/update worker
  (like eBay's `ebaySyncWorkerFn` + `ebaySync` queue, or Shopify's own much simpler
  `shopifySyncWorkerFn` + `shopifySync` queue — BASE doesn't need one since it has no async
  publish flow), add a new queue + worker. The worker doesn't need to be anywhere near as
  complex as `ebay-sync-worker`'s 700+ lines (business policies, category required-aspects,
  monthly quota) unless the channel actually has those concepts — `shopify-sync-worker` is
  the "how simple can this actually be" reference.
- **`services/lambdas/oauth-<channel>`**: a new standalone Lambda for the public OAuth
  callback, mirroring `oauth-base`/`oauth-ebay`/`oauth-shopify`. If the channel's own OAuth
  `shop`/account identifier is already known at authorize-time (Shopify's `?shop=`), no
  separate post-token-exchange "resolve my own account id" call is needed (unlike BASE/eBay's
  `getAuthenticatedShopId`/`getAuthenticatedUserId`) — use the already-known identifier
  directly as `externalAccountId`.

## Step 3: still manual — per-channel business logic that's genuinely different

- **`GET /admin/oauth/:channel/authorize-url`**'s branch body (admin-api): eBay's redirect URI
  comes from its stored `ruName`; BASE's comes from an env var; Shopify's authorize URL is
  store-specific and needs a tenant-supplied `?shop=` query param the route validates with
  `normalizeShopDomain()` before ever using it to build a URL (SSRF-sensitive — don't skip
  that validation for a new channel with a similar per-tenant-domain quirk). A new channel
  likely has its own quirk here too — add a branch, don't try to unify it away.
- **`POST /admin/products/{id}/approve-<channel>-listing`**: there is no generic "approve and
  publish to channel X" route — `approve-ebay-listing` and `approve-shopify-listing` are two
  separate, nearly-identical route handlers in admin-api (look up the channel's
  `channel_listings` row, 404/409-guard, enqueue a `<channel>_publish` job, audit-log). Copy
  one of them for a new channel rather than trying to generalize the route matching itself —
  each channel's own publish job message shape differs enough (eBay's carries no extra
  fields; a channel needing a per-tenant identifier might need to carry one) that a shared
  route body would need its own per-channel branching anyway.
- **eBay-specific admin routes** (category suggestions, required aspects, condition policies,
  business policies, webhook setup, notification topics — all under `/admin/ebay/*` in
  admin-api): these call eBay's own policy/category APIs and have no generic equivalent.
  Deliberately left untouched by this round's generalization — they're channel-specific
  business logic, not "connection management" boilerplate.
- **`apps/admin/components/orders/*`, `apps/admin/components/analytics/*`,
  `apps/admin/components/dashboard/SyncTopology.tsx`**: revenue/channel breakdowns
  (`ChannelBreakdown`, `baseRevenueJpy`/`ebayRevenueJpy` named fields) and the dashboard's
  3-node sync topology are still hardcoded to exactly 2 channels. Left alone this round —
  higher blast radius, lower payoff until a 3rd channel is real (see "Why these weren't
  touched" below).
- **`packages/core/src/product.ts`**: `SaleEvent.salePriceJpy`/`salePriceUsdCents` and
  `ExternalProduct.priceJpy` assume every channel's price is either JPY (BASE) or USD (eBay).
  A channel in a 3rd currency (e.g. a Shopify store not priced in JPY/USD) doesn't fit this
  shape — see `packages/adapters/shopify/src/client.ts`'s own comments on exactly where this
  bites.

## Step 4 (resolved): sale fan-out now notifies every other implemented channel

This used to be the one real correctness gap in this pipeline, and is the reason Shopify
could not safely be added to `IMPLEMENTED_CHANNELS` until it was fixed first. Kept here as the
worked example of what "the sale-application outbox needs updating for N channels" actually
means, in case a 4th channel ever exposes a similar gap elsewhere.

`inventory-sync-worker/src/handler.ts` used to have a `singleOtherChannel()` helper that
deliberately **threw** if `otherChannels(channel)` ever returned anything other than exactly 1
entry — a guard protecting the double-sale-prevention transaction (`applySaleWithOutbox` in
`packages/db/src/inventory.ts`) from silently misbehaving, not a bug to work around. That
transaction used to be built around **one** outbox `sync_jobs` row per sale, with an
idempotency key that had no target-channel component.

The actual fix (now live, verified by `packages/db/src/inventory.test.ts`'s and
`inventory-sync-worker/src/handler.test.ts`'s own N-channel fan-out tests):

1. `applySaleWithOutbox`'s `options.otherChannel: ChannelType` parameter became
   `options.otherChannels: ChannelType[]`.
2. It now inserts one `sync_jobs` outbox row **per** other channel inside the same
   transaction, with the target channel folded into the idempotency key
   (`channel_inventory_push:${channel}:${externalEventId}:${productId}:${otherChannel}`) —
   the old key would have silently collided `onConflictDoNothing` across the 2nd+ inserts.
3. `dispatchPhaseB` now loops over every outbox job id and dispatches to each target channel
   independently — one channel's dispatch failure never blocks another's (verified by a
   dedicated test: eBay's `setInventory` throwing still lets Shopify's own push succeed).
4. `singleOtherChannel()` itself was deleted — `otherChannels()`'s own return value is used
   directly, with no arity assumption left anywhere in this path.

A 5th channel added to `IMPLEMENTED_CHANNELS` needs **no further change here** — this is
exactly the "zero further edits" guarantee Step 1 above describes, now proven by two real
channels (eBay, Shopify) fanning out from a BASE sale simultaneously, not just claimed.

## Frontend revenue/analytics breakdowns: still not generalized, now with a real 3rd channel to test against

`ChannelBreakdown`, `RevenueTrendChart3Series`, `StackedChannelBarChart`, `ChannelProfitChart`,
and the dashboard's `SyncTopology` are all still hardcoded to exactly `{base, ebay}` with
duplicated JSX per channel, and admin-api's analytics/dashboard-summary routes still compute
these breakdowns with dozens of explicit `channel === "ebay"` branches. This was **not**
touched as part of adding Shopify — the blast radius (rewriting routes with real revenue/
profit math, not boilerplate wiring) and the fact that nothing in this round's own scope
needed it stayed true even with Shopify now real. What's changed: there's no longer an excuse
that "there's no 3rd channel's real data to render" — once Shopify has live sales flowing
through it, generalizing these views to N channels can actually be verified correct against
real data, unlike before. Worth picking up next, not bundled into this round.
