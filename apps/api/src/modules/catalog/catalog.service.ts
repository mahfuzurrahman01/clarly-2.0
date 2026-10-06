// Feature 20 (Product Catalog & Stock): business logic for product CRUD.
// Uses the same TenantContextService.withTenantTx() pattern as CustomerService
// — never a direct DB handle, so `products`' RLS policy (migration 0051) is
// the isolation boundary rather than application-level filtering.
import { Injectable } from '@nestjs/common';
import {
  and,
  eq,
  getTableColumns,
  ilike,
  notInArray,
  or,
  sql,
  type SQL,
} from 'drizzle-orm';
import { products } from '../persistence/drizzle/schema';
import { TenantContextService } from '../tenant-context/tenant-context.service';
import { categoryMatchValues } from './catalog-query-normalization';
import {
  escapeLikeTerm,
  productFuzzyMatch,
  productFuzzyRank,
  productSearchQuery,
  productSearchVector,
  productTrigramThresholdStatement,
} from './catalog-search';

export interface ProductRecord {
  id: string;
  tenantId: string;
  name: string;
  nameAr: string | null;
  sku: string | null;
  description: string | null;
  descriptionAr: string | null;
  price: string;
  currency: string;
  /** Null when the store does not track this product's stock. */
  stock: number | null;
  stockStatus: string;
  imageUrl: string | null;
  imageObjectKey: string | null;
  category: string | null;
  tags: string[] | null;
  metadata: Record<string, unknown>;
  isActive: boolean;
  createdAt: Date;
  updatedAt: Date;
}

export interface CreateProductInput {
  name: string;
  nameAr?: string;
  sku?: string;
  description?: string;
  descriptionAr?: string;
  price: number;
  currency?: string;
  stock?: number | null;
  stockStatus?: string;
  imageUrl?: string;
  imageObjectKey?: string;
  category?: string;
  tags?: string[];
  metadata?: Record<string, unknown>;
}

export interface UpdateProductInput {
  name?: string;
  nameAr?: string;
  sku?: string;
  description?: string;
  descriptionAr?: string;
  price?: number;
  currency?: string;
  stock?: number | null;
  stockStatus?: string;
  imageUrl?: string;
  imageObjectKey?: string;
  category?: string;
  tags?: string[];
  metadata?: Record<string, unknown>;
  isActive?: boolean;
}

export interface ProductListQuery {
  category?: string;
  stockStatus?: string;
  search?: string;
  limit?: number;
  offset?: number;
}

export interface ProductSearchOptions {
  limit?: number;
  category?: string;
}

/** `upsertProduct`'s result, plus which half of the upsert actually happened (import needs the created/updated split). */
export interface ProductUpsertResult {
  product: ProductRecord;
  created: boolean;
}

const DEFAULT_LIST_LIMIT = 20;
const MAX_LIST_LIMIT = 100;
const DEFAULT_SEARCH_LIMIT = 5;

@Injectable()
export class CatalogService {
  constructor(private readonly tenantContext: TenantContextService) {}

  async createProduct(
    tenantId: string,
    input: CreateProductInput,
  ): Promise<ProductRecord> {
    const [row] = await this.tenantContext.withTenantTx(
      (tx) =>
        tx.insert(products).values(toInsertValues(tenantId, input)).returning(),
      tenantId,
    );

    return toRecord(row);
  }

  async getProduct(
    tenantId: string,
    productId: string,
  ): Promise<ProductRecord | null> {
    const rows = await this.tenantContext.withTenantTx(
      (tx) =>
        tx
          .select()
          .from(products)
          .where(
            and(
              eq(products.id, productId),
              eq(products.tenantId, tenantId),
              eq(products.isActive, true),
            ),
          )
          .limit(1),
      tenantId,
    );
    return rows[0] ? toRecord(rows[0]) : null;
  }

  async listProducts(
    tenantId: string,
    query: ProductListQuery = {},
  ): Promise<{ products: ProductRecord[]; total: number }> {
    const limit = Math.min(query.limit ?? DEFAULT_LIST_LIMIT, MAX_LIST_LIMIT);
    const offset = query.offset ?? 0;

    const conditions = [
      eq(products.tenantId, tenantId),
      eq(products.isActive, true),
    ];

    if (query.category) {
      conditions.push(categoryCondition(query.category));
    }
    if (query.stockStatus) {
      conditions.push(eq(products.stockStatus, query.stockStatus));
    }
    if (query.search?.trim()) {
      // Console-side filter (not the agent path): substring match is the
      // right behaviour for a merchant typing into a list filter, but the
      // term is escaped so a bare `%` cannot mean "everything".
      const pattern = `%${escapeLikeTerm(query.search.trim())}%`;
      conditions.push(
        or(
          ilike(products.name, pattern),
          ilike(products.nameAr, pattern),
          ilike(products.sku, pattern),
        )!,
      );
    }

    const where = and(...conditions);

    const [countResult, rows] = await this.tenantContext.withTenantTx(
      async (tx) => {
        const countResult = await tx
          .select({ count: sql<number>`count(*)::int` })
          .from(products)
          .where(where);
        const rows = await tx
          .select()
          .from(products)
          .where(where)
          .orderBy(sql`${products.createdAt} desc`)
          .limit(limit)
          .offset(offset);
        return [countResult, rows] as const;
      },
      tenantId,
    );

    return {
      products: rows.map(toRecord),
      total: countResult[0]?.count ?? 0,
    };
  }

  async updateProduct(
    tenantId: string,
    productId: string,
    input: UpdateProductInput,
  ): Promise<ProductRecord | null> {
    const [row] = await this.tenantContext.withTenantTx(
      (tx) =>
        tx
          .update(products)
          .set({ ...toUpdateValues(input), updatedAt: new Date() })
          .where(
            and(eq(products.id, productId), eq(products.tenantId, tenantId)),
          )
          .returning(),
      tenantId,
    );

    return row ? toRecord(row) : null;
  }

  async deleteProduct(tenantId: string, productId: string): Promise<boolean> {
    const [row] = await this.tenantContext.withTenantTx(
      (tx) =>
        tx
          .update(products)
          .set({ isActive: false, updatedAt: new Date() })
          .where(
            and(eq(products.id, productId), eq(products.tenantId, tenantId)),
          )
          .returning(),
      tenantId,
    );

    return !!row;
  }

  /**
   * Update stock for a store-synced product (F24 webhooks).
   *
   * `externalId` is the STORE's product id. StoreSyncService writes it in two
   * places — `sku` (only when the store gave no real SKU of its own) and
   * always into `metadata.storeExternalId`. Matching on `sku` alone therefore
   * silently no-ops for every product that has a real SKU, which is most of a
   * real merchant's catalog: the webhook returns 200, nothing changes, and
   * the agent keeps quoting stale stock. Match on either.
   *
   * `stock: null` means the store does not track this product's stock.
   */
  async updateStock(
    tenantId: string,
    externalId: string,
    stock: number | null,
  ): Promise<boolean> {
    // Null = the store stopped counting this product: still purchasable.
    const stockStatus =
      stock === null || stock > 0 ? 'in_stock' : 'out_of_stock';
    const rows = await this.tenantContext.withTenantTx(
      (tx) =>
        tx
          .update(products)
          .set({ stock, stockStatus, updatedAt: new Date() })
          .where(
            and(
              eq(products.tenantId, tenantId),
              or(
                eq(products.sku, externalId),
                sql`${products.metadata} ->> 'storeExternalId' = ${externalId}`,
              ),
            ),
          )
          .returning({ id: products.id }),
      tenantId,
    );
    return rows.length > 0;
  }

  /**
   * Upsert by (tenant_id, sku) in ONE statement. Used by CSV import and store
   * sync.
   *
   * Deliberately a single `INSERT ... ON CONFLICT DO UPDATE` rather than
   * select-then-insert-or-update: those were two separate transactions, so a
   * CSV import and a store sync touching the same SKU concurrently both saw
   * "no existing row" and the loser died on the unique constraint
   * (`products_tenant_id_sku_unique`) — a duplicate-key 500 in the middle of
   * an import. `xmax = 0` is how Postgres tells us which half ran, so callers
   * still get an accurate created/updated split without a second read.
   *
   * A null sku has no conflict target (NULLs are distinct in a unique index),
   * so it always inserts — same as before.
   */
  async upsertProduct(
    tenantId: string,
    input: CreateProductInput,
  ): Promise<ProductRecord> {
    const { product } = await this.upsertProductDetailed(tenantId, input);
    return product;
  }

  async upsertProductDetailed(
    tenantId: string,
    input: CreateProductInput,
  ): Promise<ProductUpsertResult> {
    const [result] = await this.upsertProductsDetailed(tenantId, [input]);
    return result;
  }

  /**
   * Batch form of {@link upsertProductDetailed} — one statement for the whole
   * batch, one transaction. CSV import uses this instead of a per-row
   * round-trip (a 1000-row paste was 2000+ sequential queries on a single
   * HTTP request).
   */
  async upsertProductsDetailed(
    tenantId: string,
    inputs: readonly CreateProductInput[],
  ): Promise<ProductUpsertResult[]> {
    if (inputs.length === 0) return [];

    const rows = await this.tenantContext.withTenantTx(
      (tx) =>
        tx
          .insert(products)
          .values(inputs.map((input) => toInsertValues(tenantId, input)))
          .onConflictDoUpdate({
            target: [products.tenantId, products.sku],
            set: {
              name: sql`excluded.name`,
              nameAr: sql`excluded.name_ar`,
              description: sql`excluded.description`,
              descriptionAr: sql`excluded.description_ar`,
              price: sql`excluded.price`,
              currency: sql`excluded.currency`,
              stock: sql`excluded.stock`,
              stockStatus: sql`excluded.stock_status`,
              imageUrl: sql`coalesce(excluded.image_url, ${products.imageUrl})`,
              imageObjectKey: sql`coalesce(excluded.image_object_key, ${products.imageObjectKey})`,
              category: sql`excluded.category`,
              tags: sql`excluded.tags`,
              metadata: sql`${products.metadata} || excluded.metadata`,
              isActive: sql`true`,
              updatedAt: new Date(),
            },
          })
          .returning({
            ...getTableColumns(products),
            // xmax is 0 on a freshly inserted tuple and non-zero on one the
            // ON CONFLICT path updated.
            wasInserted: sql<boolean>`(xmax = 0)`,
          }),
      tenantId,
    );

    return rows.map((row) => {
      const { wasInserted, ...product } = row;
      return { product: toRecord(product), created: wasInserted };
    });
  }

  /**
   * Catalog search for the agent tool (`lookup_product`) and the console's
   * search endpoint.
   *
   * Three passes, each running only if the one before it under-delivered,
   * and each bounded to the slots still unfilled:
   *
   * 1. **Full text** — GIN-indexed `to_tsvector` over name/name_ar/sku/
   *    category/description (migration 0053). Exact and near-exact wording.
   * 2. **Substring** — covers partial SKUs and transliterations the
   *    tokenizer splits differently (`WM-0` for `WM-001`).
   * 3. **Trigram** — GIN-indexed `%` over the same document (migration
   *    0057). This is what makes "wirless mous" resolve at all, and it is
   *    the headline `photo -> product -> price` path: the vision model's
   *    description of a photo rarely matches the merchant's own wording.
   *
   * Pass order IS the ranking: a fuzzy hit can never outrank an exact one,
   * because it is only ever appended to a result set the earlier passes
   * failed to fill.
   *
   * Every pass is tenant- and is_active-scoped, later passes exclude rows
   * already returned, and the term's LIKE wildcards are escaped so a `%`
   * query cannot exfiltrate the whole catalog. The trigram pass needs no
   * escaping (wildcards carry no trigrams) but is threshold-bounded for the
   * same reason — see PRODUCT_TRGM_SIMILARITY_THRESHOLD.
   */
  async searchProducts(
    tenantId: string,
    query: string,
    limitOrOptions: number | ProductSearchOptions = DEFAULT_SEARCH_LIMIT,
  ): Promise<ProductRecord[]> {
    const options: ProductSearchOptions =
      typeof limitOrOptions === 'number'
        ? { limit: limitOrOptions }
        : limitOrOptions;
    const limit = Math.min(
      options.limit ?? DEFAULT_SEARCH_LIMIT,
      MAX_LIST_LIMIT,
    );
    const term = query.trim();
    if (!term) return [];

    const base = [
      eq(products.tenantId, tenantId),
      eq(products.isActive, true),
      ...(options.category ? [categoryCondition(options.category)] : []),
    ];
    const tsQuery = productSearchQuery(term);
    const pattern = `%${escapeLikeTerm(term)}%`;

    const rows = await this.tenantContext.withTenantTx(async (tx) => {
      /** `notInArray` over an empty list is invalid SQL, so absent when nothing is found yet. */
      const excluding = (found: readonly { id: string }[]) =>
        found.length
          ? [
              notInArray(
                products.id,
                found.map((row) => row.id),
              ),
            ]
          : [];

      const matched = await tx
        .select()
        .from(products)
        .where(and(...base, sql`${productSearchVector} @@ ${tsQuery}`))
        .orderBy(sql`ts_rank(${productSearchVector}, ${tsQuery}) desc`)
        .limit(limit);

      if (matched.length >= limit) return matched;

      const substring = await tx
        .select()
        .from(products)
        .where(
          and(
            ...base,
            ...excluding(matched),
            or(
              ilike(products.name, pattern),
              ilike(products.nameAr, pattern),
              ilike(products.sku, pattern),
            ),
          ),
        )
        .limit(limit - matched.length);

      const found = [...matched, ...substring];
      if (found.length >= limit) return found;

      // Transaction-local, so it is reverted at commit rather than left
      // behind on whichever pooled connection this transaction borrowed.
      await tx.execute(productTrigramThresholdStatement);

      const fuzzy = await tx
        .select()
        .from(products)
        .where(and(...base, ...excluding(found), productFuzzyMatch(term)))
        .orderBy(sql`${productFuzzyRank(term)} desc`)
        .limit(limit - found.length);

      return [...found, ...fuzzy];
    }, tenantId);

    return rows.map(toRecord);
  }
}

/**
 * Exact match on the category, except for a recognised category word
 * ("kitchen", "مطبخ"), which matches any spelling a tenant may have stored,
 * case-insensitively — merchants import "Kitchen" as often as "kitchen".
 */
function categoryCondition(category: string): SQL {
  const values = categoryMatchValues(category);
  return values
    ? sql`lower(${products.category}) in (${sql.join(
        values.map((value) => sql`${value}`),
        sql`, `,
      )})`
    : eq(products.category, category);
}

function toInsertValues(
  tenantId: string,
  input: CreateProductInput,
): typeof products.$inferInsert {
  return {
    tenantId,
    name: input.name,
    nameAr: input.nameAr,
    sku: input.sku,
    description: input.description,
    descriptionAr: input.descriptionAr,
    price: String(input.price),
    currency: input.currency ?? 'SAR',
    // `??` would turn an untracked (null) stock into 0, i.e. sold out.
    stock: input.stock === undefined ? 0 : input.stock,
    stockStatus: input.stockStatus ?? 'in_stock',
    imageUrl: input.imageUrl,
    imageObjectKey: input.imageObjectKey,
    category: input.category,
    tags: input.tags ?? [],
    metadata: input.metadata ?? {},
  };
}

function toUpdateValues(
  input: UpdateProductInput,
): Partial<typeof products.$inferInsert> {
  return {
    ...(input.name !== undefined && { name: input.name }),
    ...(input.nameAr !== undefined && { nameAr: input.nameAr }),
    ...(input.sku !== undefined && { sku: input.sku }),
    ...(input.description !== undefined && { description: input.description }),
    ...(input.descriptionAr !== undefined && {
      descriptionAr: input.descriptionAr,
    }),
    ...(input.price !== undefined && { price: String(input.price) }),
    ...(input.currency !== undefined && { currency: input.currency }),
    ...(input.stock !== undefined && { stock: input.stock }),
    ...(input.stockStatus !== undefined && { stockStatus: input.stockStatus }),
    ...(input.imageUrl !== undefined && { imageUrl: input.imageUrl }),
    ...(input.imageObjectKey !== undefined && {
      imageObjectKey: input.imageObjectKey,
    }),
    ...(input.category !== undefined && { category: input.category }),
    ...(input.tags !== undefined && { tags: input.tags }),
    ...(input.metadata !== undefined && { metadata: input.metadata }),
    ...(input.isActive !== undefined && { isActive: input.isActive }),
  };
}

function toRecord(row: typeof products.$inferSelect): ProductRecord {
  return {
    id: row.id,
    tenantId: row.tenantId,
    name: row.name,
    nameAr: row.nameAr,
    sku: row.sku,
    description: row.description,
    descriptionAr: row.descriptionAr,
    price: row.price,
    currency: row.currency,
    stock: row.stock,
    stockStatus: row.stockStatus,
    imageUrl: row.imageUrl,
    imageObjectKey: row.imageObjectKey,
    category: row.category,
    tags: row.tags,
    metadata: row.metadata as Record<string, unknown>,
    isActive: row.isActive,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}
