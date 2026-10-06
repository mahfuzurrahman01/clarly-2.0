-- Feature 20 (Product Catalog & Stock): the fuzzy half of D4, which 0053
-- deferred.
--
-- 0053's header said pg_trgm was "a bootstrap change, not a migration", and
-- that is still true of the EXTENSION — what changed is that the bootstrap
-- now makes it (docker/postgres-init/01-app-role.sql for local dev, the CI
-- workflow's bootstrap step for CI, both run as superuser BEFORE app_user's
-- migrations, exactly like `vector`). The `CREATE EXTENSION IF NOT EXISTS`
-- below is therefore a no-op on every environment that is bootstrapped
-- correctly: Postgres checks existence before privilege, so app_user never
-- reaches the privilege check.
--
-- It is deliberately NOT wrapped in an exception handler. A deployment where
-- pg_trgm is genuinely absent must fail here, loudly, at migrate time —
-- because the alternative is `lookup_product` throwing "operator does not
-- exist: text % text" on a live customer turn, which is the headline
-- photo -> product -> price path failing in production instead of in CI.
-- Supabase's Postgres ships pg_trgm; it only needs enabling, which this does.
CREATE EXTENSION IF NOT EXISTS pg_trgm;--> statement-breakpoint

-- The trigram index, on the SAME document expression as 0053's full-text
-- index and as `productSearchDocument` in catalog-search.ts. Postgres only
-- uses an expression index when the query's parse tree matches the index's,
-- so drift between these three spellings silently reverts catalog search to
-- a sequential scan with no test failing — catalog-search.spec.ts pins the
-- TypeScript side against this text.
--
-- gin_trgm_ops (not gist_trgm_ops): this index serves the `%` similarity
-- operator on a read-mostly table, where GIN's faster lookups beat GiST's
-- cheaper updates. A product row changes when a merchant edits it or a store
-- webhook syncs stock; it is read on every agent turn that mentions a
-- product.
CREATE INDEX IF NOT EXISTS "products_search_trgm_idx"
  ON "products"
  USING gin (
    (
      coalesce("name", '') || ' ' ||
      coalesce("name_ar", '') || ' ' ||
      coalesce("sku", '') || ' ' ||
      coalesce("category", '') || ' ' ||
      coalesce("description", '') || ' ' ||
      coalesce("description_ar", '')
    ) gin_trgm_ops
  );
