# @ai-ec/adapter-rakuten

**This is a scaffold, not a production integration** — same disclosure as
`@ai-ec/adapter-shopify`/`@ai-ec/adapter-amazon`: it compiles, typechecks, and its unit tests
pass against mocked HTTP responses, but has **never been run against a real RMS-registered
Rakuten Ichiba shop**.

**Confidence note (read this before the other two):** this codebase's training data has much
thinner public coverage of RMS (Rakuten Merchant Server) API 2.0's exact field names than it
does of Shopify's or Amazon SP-API's public docs. Every field name in `client.ts` is a
best-effort placeholder — verify against Rakuten's own RMS API reference (available inside the
RMS merchant control panel, not fully public) more carefully than you would for the other two
scaffolds.

One thing that **is** confidently real, and shapes the design here: RMS's classic API auth is
**not an OAuth2 redirect flow**. A shop owner generates their own license key inside the RMS
control panel and hands it to the connecting app directly — there's no "authorize on
Rakuten's site, get redirected back" step. `getAuthorizationUrl`/`exchangeCodeForToken`/
`refreshToken` all throw here rather than fake a flow that doesn't exist. This has a real
product-UI consequence: connecting/reconnecting Rakuten needs its own form (paste your
license key), not the "再接続" redirect button every other channel's ConnectionCard uses —
see `client.ts`'s own class doc and `docs/adding-a-channel.md`.
