// Feature 1: T5's first real RLS-scoped table, doubling as A2's tenant tool
// registry (AI_PIPELINE_PLAN.md: "tenant tool registry -> JSON schema for
// L3"). One row per tool a tenant has enabled; `jsonSchema` is what
// PromptModule (Feature 3) will read to build L3 — the *validation* Zod
// schema for T2's ToolExecutionModule lives in code
// (tool-execution/tool-definitions.ts), not reconstructed from this JSON
// column, per AI_PIPELINE_PLAN's "prompt-visible and execution-validated
// schema are the same object" requirement.
//
// RLS: FORCE-enabled (see 0001_tenant-isolation.sql) so isolation holds even
// for the table owner — see docs/decisions/F1-security.md for why this
// matters (Postgres RLS is a silent no-op for superusers/BYPASSRLS roles
// regardless of policy, so the connecting role's privileges are as
// load-bearing as the policy SQL itself).
import {
  pgTable,
  uuid,
  text,
  boolean,
  timestamp,
  jsonb,
  unique,
} from 'drizzle-orm/pg-core';
import { tenants } from './tenants.table';

export const tenantTools = pgTable(
  'tenant_tools',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => tenants.id, { onDelete: 'cascade' }),
    name: text('name').notNull(),
    description: text('description').notNull(),
    /** JSON schema shown to the model in L3 — generated only from this tenant's enabled tools. */
    jsonSchema: jsonb('json_schema').notNull(),
    enabled: boolean('enabled').notNull().default(true),
    createdAt: timestamp('created_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    unique('tenant_tools_tenant_id_name_unique').on(table.tenantId, table.name),
  ],
).enableRLS();
