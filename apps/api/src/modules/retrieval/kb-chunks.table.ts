// A1/D3: kb_chunks — deliberately NOT re-exported from persistence/drizzle/
// schema.ts's barrel (drizzle-kit's auto-diff target for `db:generate`).
// The actual DDL (PARTITION BY LIST, HNSW/GIN indexes, a generated tsvector
// column) is hand-authored SQL — migrations/0008_kb-chunks-pgvector.sql —
// because those features are past what drizzle-kit's declarative table
// builder round-trips cleanly. This file exists only so RetrievalModule's
// own query-building code has a typed Drizzle table object to work with;
// running `drizzle-kit generate` will never see or diff it, so it can't
// produce a conflicting ALTER statement against the hand-written migration.
//
// This is also rule 3's actual home: the `vector` custom column type is
// the one place in the codebase that imports/defines a pgvector-specific
// TypeScript type, and it lives inside RetrievalModule, not
// PersistenceModule's shared schema barrel.
import {
  customType,
  integer,
  pgTable,
  primaryKey,
  text,
  timestamp,
  uuid,
} from 'drizzle-orm/pg-core';

/** pgvector stores/returns vectors as a Postgres array literal string, e.g. "[0.1,0.2,0.3]" — node-postgres has no built-in parser for the `vector` type, so this customType is where that string <-> number[] conversion happens, once, rather than at every call site. */
const vector = customType<{ data: number[]; driverData: string }>({
  // Must equal the served embedding model's native width — the adapter
  // cannot truncate (no Matryoshka support), so this and EMBEDDING_DIMENSIONS
  // move together, and both are pinned by envSchema. See migration 0023.
  dataType() {
    return 'vector(1024)';
  },
  toDriver(value: number[]): string {
    return `[${value.join(',')}]`;
  },
  fromDriver(value: string): number[] {
    return value
      .slice(1, -1)
      .split(',')
      .filter((entry) => entry.length > 0)
      .map(Number);
  },
});

// content_tsv (generated column, GIN-indexed for D4's lexical search) is
// deliberately NOT modeled here — the app never writes to it (Postgres
// computes it from `content`), and lexical search is done via raw SQL
// (pg-vector-store.ts), not through this Drizzle table object.
export const kbChunks = pgTable(
  'kb_chunks',
  {
    id: uuid('id').notNull().defaultRandom(),
    tenantId: uuid('tenant_id').notNull(),
    kbDocumentId: uuid('kb_document_id').notNull(),
    chunkIndex: integer('chunk_index').notNull(),
    content: text('content').notNull(),
    embedding: vector('embedding').notNull(),
    embeddingModel: text('embedding_model').notNull(),
    embeddingVersion: text('embedding_version').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [primaryKey({ columns: [table.id, table.tenantId] })],
);
