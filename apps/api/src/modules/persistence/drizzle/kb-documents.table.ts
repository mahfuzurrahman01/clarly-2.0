// Feature 2.5: KB document registry — the record a raw upload becomes once
// KbDocumentService.upload() stores the file (ObjectStorage port,
// KnowledgeBaseModule) and enqueues an ingest job. Deliberately does NOT
// contain chunks/embeddings/pgvector — D3's kb_chunks table (LIST-
// partitioned by tenant_id, HNSW per partition) is Feature 3's A1 work;
// this table only tracks "does this raw document exist and has it been
// handed to the ingest pipeline," so nothing here imports pgvector types
// (rule 3 stays intact even once A1 lands).
//
// RLS: same FORCE + NULLIF guard pattern as Feature 1/2's tables.
import { pgTable, uuid, text, integer, timestamp } from 'drizzle-orm/pg-core';
import { tenants } from './tenants.table';

/** 'ingested'/'failed' are set by whichever consumer processes the kb-ingest job — Feature 3's A1 pipeline once it exists; today's placeholder processor only ever reaches 'failed'. */
export const KB_DOCUMENT_STATUSES = [
  'uploaded',
  'ingest_queued',
  'ingested',
  'failed',
] as const;
export type KbDocumentStatus = (typeof KB_DOCUMENT_STATUSES)[number];

export const kbDocuments = pgTable('kb_documents', {
  id: uuid('id').primaryKey().defaultRandom(),
  tenantId: uuid('tenant_id')
    .notNull()
    .references(() => tenants.id, { onDelete: 'cascade' }),
  filename: text('filename').notNull(),
  /** ObjectStorage key — opaque to callers, resolved back to bytes only via the port. */
  storageKey: text('storage_key').notNull().unique(),
  mimeType: text('mime_type').notNull(),
  sizeBytes: integer('size_bytes').notNull(),
  status: text('status').notNull().default('uploaded'),
  createdAt: timestamp('created_at', { withTimezone: true })
    .notNull()
    .defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true })
    .notNull()
    .defaultNow(),
}).enableRLS();
