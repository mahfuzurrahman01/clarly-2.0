// F19 (D1): a segment is a SAVED QUERY (a JSON filter tree), not a
// materialized customer list — see docs/decisions/F19-campaigns-broadcast.md.
// The console's preview endpoint re-runs `definition` live; a campaign
// snapshots the result into `campaign_recipients` once, at launch (see
// campaigns.table.ts / campaign-recipients.table.ts).
import {
  pgTable,
  uuid,
  text,
  jsonb,
  integer,
  timestamp,
  unique,
} from 'drizzle-orm/pg-core';
import { tenants } from './tenants.table';

/**
 * Deliberately untyped as a domain shape here — `persistence/drizzle` must
 * not depend on a feature module (see `channel-kind.ts`'s header comment for
 * the same rule applied to the `channel` column). `SegmentNode`
 * (`modules/campaign/segment-definition.schema.ts`) is the real shape;
 * `SegmentService` casts through it after re-validating with
 * `segmentDefinitionSchema`, per D1's "validated on every write AND every
 * read" rule.
 */
export type SegmentDefinitionJson = Record<string, unknown>;

export const segments = pgTable(
  'segments',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => tenants.id, { onDelete: 'cascade' }),
    name: text('name').notNull(),
    description: text('description'),
    /**
     * The filter tree. Validated by `segmentDefinitionSchema` (Zod) on every
     * write AND again on every read before compilation — a row hand-edited
     * in the DB must not reach `SegmentCompiler` unvalidated.
     */
    definition: jsonb('definition').notNull().$type<SegmentDefinitionJson>(),
    /** Cache of the last preview, for the list view. Advisory only: never used to decide who gets a message. */
    lastResolvedCount: integer('last_resolved_count'),
    lastResolvedAt: timestamp('last_resolved_at', { withTimezone: true }),
    createdBy: uuid('created_by'),
    createdAt: timestamp('created_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    unique('segments_tenant_id_name_unique').on(table.tenantId, table.name),
    // Lets `campaigns.(tenant_id, segment_id)` hang a COMPOSITE FK off this,
    // the same trick `customer_labels` uses off `customers`.
    unique('segments_tenant_id_id_unique').on(table.tenantId, table.id),
  ],
).enableRLS();
