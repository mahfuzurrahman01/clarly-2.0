// Feature 20 (Product Catalog & Stock): structured product records for the
// AI agent to resolve customer product photos to live price/stock.
//
// Separate from KB documents: KB is chunked+vectorized for semantic search;
// products are structured data with exact fields (price, stock, SKU). Mixing
// them would force every price/stock query through vector search — slow and
// unreliable for structured lookups.
//
// `metadata` is the extensible JSON column for store-specific fields (Salla
// product ID, Shopify variant ID, etc.) — populated by F24 store connectors.
//
// RLS: same FORCE + NULLIF guard pattern as every other tenant table.
import {
  pgTable,
  uuid,
  text,
  integer,
  numeric,
  timestamp,
  boolean,
  jsonb,
  unique,
  index,
} from 'drizzle-orm/pg-core';
import { tenants } from './tenants.table';

export const STOCK_STATUSES = [
  'in_stock',
  'out_of_stock',
  'low_stock',
  'pre_order',
] as const;
export type StockStatus = (typeof STOCK_STATUSES)[number];

export const CURRENCIES = [
  'SAR',
  'AED',
  'KWD',
  'QAR',
  'BHD',
  'OMR',
  'EGP',
  'USD',
] as const;
export type Currency = (typeof CURRENCIES)[number];

export const products = pgTable(
  'products',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => tenants.id, { onDelete: 'cascade' }),
    name: text('name').notNull(),
    nameAr: text('name_ar'),
    sku: text('sku'),
    description: text('description'),
    descriptionAr: text('description_ar'),
    price: numeric('price', { precision: 12, scale: 2 }).notNull(),
    currency: text('currency').notNull().default('SAR'),
    // Null = the store does not track this product's stock (Salla null
    // quantity, Woo unmanaged, Shopify untracked, Zid infinite); stock_status
    // stays the availability signal.
    stock: integer('stock').default(0),
    stockStatus: text('stock_status').notNull().default('in_stock'),
    imageUrl: text('image_url'),
    imageObjectKey: text('image_object_key'),
    category: text('category'),
    tags: text('tags').array().default([]),
    metadata: jsonb('metadata').$type<Record<string, unknown>>().default({}),
    isActive: boolean('is_active').notNull().default(true),
    createdAt: timestamp('created_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    unique().on(table.tenantId, table.sku),
    index('products_tenant_id_idx').on(table.tenantId),
    index('products_tenant_id_sku_idx').on(table.tenantId, table.sku),
  ],
).enableRLS();
