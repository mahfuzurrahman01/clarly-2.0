-- Feature 20 (Product Catalog & Stock), retroactive fixes (2026-09-21):
--
-- 1. The search index F20's decision doc (D1/D4) specified and 0051 never
--    created. Without it every `lookup_product` call was a sequential scan
--    over the tenant's whole catalog — and the query itself was a substring
--    ILIKE, so a `%` term returned the entire price list.
--
--    The indexed expression MUST stay identical to `productSearchDocument`
--    in catalog-search.ts: Postgres only uses an expression index when the
--    query's parse tree matches the index's, so a drift here silently
--    reverts us to seq scans with no test failing.
--
--    `simple` (not `english`): Gulf catalogs mix Arabic and English, and the
--    english stemmer mangles Arabic tokens while doing nothing for SKUs.
--
--    pg_trgm (D4's fuzzy half) is deliberately NOT used: app_user has no
--    CREATE EXTENSION privilege (see 0008's header for the same constraint
--    with pgvector) and the extension is not part of this app's Postgres
--    bootstrap. CatalogService.searchProducts() covers the gap with a
--    bounded, wildcard-escaped substring pass that only runs when full-text
--    under-delivers. Adding pg_trgm is a bootstrap change, not a migration.
--
-- 2. `stock_status`' CHECK constraint from D1 (0051 declared the column with
--    a default but no constraint, so any string was storable).
--
-- 3. Backfills the `lookup_product` tenant_tools row for every EXISTING
--    tenant. Nothing wrote it, so the tool — fully implemented — was
--    unreachable for every tenant: ToolExecutionService.authorize() rejects
--    any tool without an enabled row. New tenants get it from
--    CatalogToolSeederService at signup; this covers the ones already
--    created. Canonical definition of both the description and the schema is
--    catalog-product.tool.ts — this backfill is a copy, and re-running the
--    app-side seeder is what refreshes it after a change there.

CREATE INDEX IF NOT EXISTS "products_search_tsv_idx"
  ON "products"
  USING gin (
    to_tsvector(
      'simple',
      (
        coalesce("name", '') || ' ' ||
        coalesce("name_ar", '') || ' ' ||
        coalesce("sku", '') || ' ' ||
        coalesce("category", '') || ' ' ||
        coalesce("description", '') || ' ' ||
        coalesce("description_ar", '')
      )
    )
  );--> statement-breakpoint

-- Category filter (`lookup_product`'s category arg, and the console's list
-- filter) is a per-tenant equality lookup.
CREATE INDEX IF NOT EXISTS "products_tenant_id_category_idx"
  ON "products" ("tenant_id", "category");--> statement-breakpoint

ALTER TABLE "products"
  DROP CONSTRAINT IF EXISTS "products_stock_status_check";--> statement-breakpoint

ALTER TABLE "products"
  ADD CONSTRAINT "products_stock_status_check"
  CHECK ("stock_status" IN ('in_stock', 'out_of_stock', 'low_stock', 'pre_order'));--> statement-breakpoint

-- tenant_tools is FORCE RLS (T5), and migrations run as app_user with no
-- tenant GUC set — a plain INSERT ... SELECT here would be rejected by the
-- policy's WITH CHECK. Setting `app.tenant_id` per row (transaction-local,
-- reverted at commit) writes each row THROUGH the policy rather than around
-- it, which is also the only version of this that stays correct if the
-- policy is ever tightened.
DO $$
DECLARE
  tenant_row record;
BEGIN
  FOR tenant_row IN SELECT "id" FROM "tenants" LOOP
    PERFORM set_config('app.tenant_id', tenant_row."id"::text, true);

    INSERT INTO "tenant_tools" ("tenant_id", "name", "description", "json_schema", "enabled")
    VALUES (
      tenant_row."id",
      'lookup_product',
      'Look up a product by name, SKU, or description. Use when the customer asks about a product, its price, or its availability — including after an image description, where the description is the query. Returns matching catalog rows with live price, currency, stock and image. Price and stock may come ONLY from this tool''s results: never state a price, currency or availability that is not in a returned row, and never carry one over from an image caption, the knowledge base, or an earlier turn. If the tool returns no products, say you need to check with the team and escalate rather than describing the product.',
      '{"type":"object","properties":{"query":{"type":"string","minLength":1,"maxLength":200,"description":"Product name, SKU, or description to search for"},"category":{"type":"string","maxLength":100,"description":"Optional category filter"},"limit":{"type":"number","minimum":1,"maximum":10,"description":"Max results (default 5)"}},"required":["query"],"additionalProperties":false}'::jsonb,
      true
    )
    ON CONFLICT ("tenant_id", "name") DO UPDATE
      SET "description" = excluded."description",
          "json_schema" = excluded."json_schema",
          "enabled" = true,
          "updated_at" = now();
  END LOOP;

  PERFORM set_config('app.tenant_id', '', true);
END $$;
