# @ai-ec/adapter-amazon

**This is a scaffold, not a production integration** — same disclosure as
`@ai-ec/adapter-shopify`: written against Amazon's publicly documented Selling Partner API
(SP-API, developer-docs.amazon.com/sp-api), compiles, typechecks, and its unit tests pass
against mocked HTTP responses, but has **never been run against a real registered SP-API
application or seller account**.

Two real gaps this scaffold does **not** paper over (see `client.ts`'s own class doc for
detail):

1. `listProducts` and `createListing` both throw. SP-API has no single "list all my
   listings" call (that needs the separate, asynchronous Reports API), and creating a
   listing needs Amazon's per-product-type attribute schema, which `CreateListingInput`'s
   flat shape has no room for.
2. Every Listings/Orders call needs a per-seller `sellerId` that varies per tenant, which
   `ChannelAdapter`'s shared interface has no parameter for — this adapter takes it in its
   constructor config instead, which means it does **not** fit
   `@ai-ec/lambda-shared`'s `loadImplementedChannelAdapters()` "one shared instance for every
   tenant" pattern as written today. A real integration needs either an interface change or a
   different, per-tenant construction path.

Before using this for anything real: verify every endpoint/field against Amazon's current
SP-API reference and a real sandbox seller account, register a real SP-API application, and
resolve the two gaps above. See `docs/adding-a-channel.md` at the repo root.
