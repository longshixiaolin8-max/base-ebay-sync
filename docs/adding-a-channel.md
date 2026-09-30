# Adding a new sales channel (Amazon, 楽天市場, Yahoo!ショッピング, Shopify)

`README.md` and `packages/core/src/channel.ts`/`adapter.ts` say adding a channel is "just
implement `ChannelAdapter`". That's true for the adapter itself, but a repo-wide audit (done
alongside this doc) found several other places that still hardcode "exactly BASE and eBay".
This doc is the honest, current checklist: what's now automatic once you add a channel to
`IMPLEMENTED_CHANNELS`, and what you still have to touch by hand.

## Which channel is actually worth adding next

`ChannelType` (`packages/core/src/channel.ts`) isn't "every marketplace that exists" — it's
narrowed to channels a real, existing competitor already integrates with, not a speculative
guess. Checked against 3 real Japanese EC一元管理 (multi-channel commerce sync) tools —
ネクストエンジン (Next Engine), CROSS MALL, GoQSystem:

| Channel | Why it's on the list |
| --- | --- |
| `amazon`, `rakuten` | Every one of the 3 tools above supports both as baseline coverage. |
| `yahoo_shopping` | The 3rd of Japan's "big 3" marketplaces — Amazon・楽天市場・Yahoo!ショッピング is the standard baseline every one of those tools lists, not just 2 of the 3. |
| `shopify` | Not a marketplace (it's a storefront platform like BASE itself), but real, confirmed demand exists: CROSS MALL's operator (アイル) is a certified **Shopify Experts** partner, and Next Engine ships its own dedicated Shopify sync app. Already has a concrete scaffold: `packages/adapters/shopify`. |

Deliberately **not** on the list (yet): au PAYマーケット, Qoo10, メルカリShops, TikTok Shop,
ZOZOTOWN and the various fashion-vertical malls CROSS MALL also supports — these came up in
the same research pass but are a clear second tier (supported by some, not all, of the tools
checked), not the "everyone integrates with this" bar the current 4 meet. Worth revisiting if
a specific tenant actually asks for one of them, not worth speculatively building ahead of
demand.

Amazon and 楽天市場 (`rakuten`) are already in `ChannelType` but have no adapter package yet —
that's the actual next piece of real work here, not Yahoo!ショッピング or Shopify (Shopify
already has its scaffold). Both Amazon (SP-API) and 楽天市場 (RMS API) have official,
public seller APIs suitable for the same `client.ts`-against-public-docs treatment
`packages/adapters/shopify` already got.

## Step 0: implement the adapter

Copy `packages/adapters/shopify`'s file layout (`config.ts`, `client.ts`, `client.test.ts`,
`index.ts`) into a new `packages/adapters/<channel>` package. `shopify`'s own `client.ts`
implements `ChannelAdapter` against Shopify's real public API and is unit-tested, but has
**never been run against a live store** — see that package's README before treating it as
more than a template. Whatever channel you're adding, verify every endpoint/field against
that channel's current API reference and (ideally) a real sandbox account, the way
`packages/adapters/base/src/client.ts`'s comments document having been checked against a live
BASE account.

## Step 1: now automatic (as of this round's generalization)

These pick up a new channel with **zero further edits**, as long as you also do Step 2/3
below:

- **`otherChannels()`** (`packages/core/src/channel.ts`) returns every other implemented
  channel, not just "the one other channel" — genuinely N-channel safe.
- **`loadImplementedChannelAdapters()`** (`services/lambdas/shared/src/channel-adapters.ts`)
  is the one place `inventory-sync-worker`, `inventory-diff-check` and `tenant-offboarding`
  build their `{channel: adapter}` map from. Add one line here for the new channel's
  credentials + adapter construction, and all three workers pick it up.
- **`GET /admin/sync/connections`** (admin-api) loop-builds its response from
  `IMPLEMENTED_CHANNELS` — a new channel gets a `connections.<channel>` key with zero route
  changes.
- **`GET /admin/oauth/:channel/authorize-url`** and **`POST /admin/oauth/:channel/disconnect`**
  (admin-api) validate the `:channel` path segment against `IMPLEMENTED_CHANNELS` instead of a
  hardcoded `(base|ebay)` regex — a new channel is accepted by the route matcher automatically
  (the authorize-url route's *branch body* per channel is still Step 3, see below).
- **`apps/admin/lib/channel-meta.ts`**'s `CHANNEL_META`/`DISPLAYED_CHANNELS` drive
  `ConnectionCard.tsx` and `ConnectionsTab.tsx`'s connection cards — add one entry to each
  constant and a 3rd card renders with no JSX changes.
- **`inventory-diff-check`** and **`tenant-offboarding`**'s own per-tenant loops already index
  into a `Partial<Record<ChannelType, ChannelAdapter>>` by whatever channel a `channel_listings`
  row says — no per-channel branching in their business logic.

## Step 2: still manual — infrastructure

None of this is safely auto-generalizable without real deployment testing against the new
channel's actual OAuth app / webhook needs:

- **Secrets Manager** (`infra/lib/secrets-stack.ts`): add a new `secretsmanager.Secret` field
  for the channel's app credentials, matching `baseAppCredentials`/`ebayAppCredentials`.
- **CDK Lambdas** (`infra/lib/lambda-stack.ts`): if the channel needs its own OAuth callback
  route or webhook receiver (most will), add a new Lambda construct + route + secret grant,
  mirroring `oauthBaseCallbackFn`/`oauthEbayCallbackFn`/`ebaySyncWorkerFn`/`ebay-webhook`.
- **SQS** (`infra/lib/queue-stack.ts`): if the channel needs an async publish/update worker
  (like eBay's `ebaySyncWorkerFn` + `ebaySync` queue — BASE doesn't need one since it has no
  async publish flow), add a new queue.
- **`services/lambdas/oauth-<channel>`**: a new standalone Lambda for the public OAuth
  callback, mirroring `oauth-base`/`oauth-ebay`.

## Step 3: still manual — per-channel business logic that's genuinely different

- **`GET /admin/oauth/:channel/authorize-url`**'s branch body (admin-api): eBay's redirect URI
  comes from its stored `ruName`; BASE's comes from an env var. A new channel likely has its
  own quirk here too — add a branch, don't try to unify it away.
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

## Step 4: the one real correctness gap — sale fan-out assumes exactly 1 other channel

`inventory-sync-worker/src/handler.ts`'s `singleOtherChannel()` deliberately **throws** if
`otherChannels(channel)` ever returns anything other than exactly 1 entry. This is not a bug
to silently work around — it's a guard protecting the double-sale-prevention transaction
(`applySaleWithOutbox` in `packages/db/src/inventory.ts`) from silently misbehaving.

That transaction is built around **one** outbox `sync_jobs` row per sale, with an idempotency
key that has no target-channel component
(`channel_inventory_push:${channel}:${externalEventId}:${productId}`). A sale on channel A must
notify **every** other channel holding stock, not just one, once a 3rd channel exists. Doing
this for real requires:

1. Changing `applySaleWithOutbox`'s `options.otherChannel: ChannelType` parameter to
   `options.otherChannels: ChannelType[]`.
2. Inserting one `sync_jobs` outbox row **per** other channel inside the same transaction,
   with the target channel folded into the idempotency key (e.g.
   `channel_inventory_push:${channel}:${externalEventId}:${productId}:${otherChannel}`) — the
   current key would silently collide `onConflictDoNothing` across the 2nd+ inserts otherwise.
3. Changing `dispatchPhaseB` to loop over multiple outbox job ids and dispatch to each target
   channel independently (one channel's dispatch failure must not block another's).
4. Updating `inventory-sync-worker/src/handler.test.ts`'s idempotency/double-decrement tests
   to cover the N-other-channel case, not just today's single-other-channel case.

Until this is done, do not remove `singleOtherChannel()`'s guard — a 3rd channel added to
`IMPLEMENTED_CHANNELS` without this fix would silently sync to only one of the other channels
(or throw, per the guard, which is the safe failure mode).

## Why the frontend revenue/analytics breakdowns weren't touched this round

`ChannelBreakdown`, `RevenueTrendChart3Series`, `StackedChannelBarChart`, `ChannelProfitChart`,
and the dashboard's `SyncTopology` are all hardcoded to exactly `{base, ebay}` with duplicated
JSX per channel. Generalizing these to render N channels has no way to be verified correct
right now (there's no 3rd channel's real data to render), and touching admin-api's
analytics/dashboard-summary routes (which compute these breakdowns with dozens of
`channel === "ebay"` branches) carries real regression risk for zero current behavioral
benefit. Do this once a real 3rd channel actually exists and its data needs to show up in
these views — not speculatively.
