// F9: which knowledge-base documents an agent may answer from.
//
// EMPTY MEANS EVERYTHING. An agent with no rows here retrieves across the
// tenant's whole knowledge base, which is both the behaviour every agent had
// before this table existed and the right default: a tenant who has not
// thought about scoping should not discover that their agent can answer
// nothing.
//
// Not versioned with `agent_versions`, for the same reason the number binding
// is not: rolling a persona back to last week must not silently change which
// documents the agent is allowed to read, which is a live access decision.
import { pgTable, uuid, timestamp, unique } from 'drizzle-orm/pg-core';
import { tenants } from './tenants.table';
import { agents } from './agents.table';
import { kbDocuments } from './kb-documents.table';

export const agentKbDocuments = pgTable(
  'agent_kb_documents',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => tenants.id, { onDelete: 'cascade' }),
    agentId: uuid('agent_id')
      .notNull()
      .references(() => agents.id, { onDelete: 'cascade' }),
    kbDocumentId: uuid('kb_document_id')
      .notNull()
      .references(() => kbDocuments.id, { onDelete: 'cascade' }),
    createdAt: timestamp('created_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [unique().on(table.agentId, table.kbDocumentId)],
).enableRLS();
