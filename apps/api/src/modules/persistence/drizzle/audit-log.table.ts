// The record of who did what, for a buyer's security review and for the
// tenant's own "who deleted that?" question.
//
// Two retention properties, both deliberate and both different from every
// other table here:
//
//   - T16's 90-day transcript purge must NEVER touch this. An audit log that
//     ages out cannot answer a question about last year, which is most of
//     what it is asked. Nothing here references `conversations` or `messages`,
//     so there is no cascade path from the purge — the same reasoning that
//     keeps `conversation_outcomes` safe, applied on purpose rather than by
//     luck.
//   - `tenantId` DOES cascade. Full tenant offboarding removes everything for
//     that tenant, audit history included; that is a different operation from
//     transcript purge and it should be complete.
//
// Append-only by policy, not just by convention. Migration 0037 gives this
// table a SELECT policy and an INSERT policy and deliberately no UPDATE or
// DELETE policy — under FORCE ROW LEVEL SECURITY a command with no permissive
// policy matches zero rows, and that applies to the table's owner too. So
// nothing in the application can rewrite history, including the role that runs
// migrations. A log the product can edit is not evidence of anything.
//
// Not done with REVOKE, which would have been theatre: `app_user` owns this
// table, and an owner's implicit privileges are not governed by GRANT/REVOKE.
//
// `actorUserId` is a Supabase Auth user id with no local foreign key, same as
// `tickets.assigneeId` — there is no local users table. That is also why the
// actor's email is NOT denormalized here: it is resolved at read time through
// TenantAuthProvisioningPort, so a log entry never goes stale against a
// renamed account, and a removed member's actions stay attributable.
import {
  pgTable,
  uuid,
  text,
  integer,
  timestamp,
  index,
  jsonb,
} from 'drizzle-orm/pg-core';
import { tenants } from './tenants.table';

/** Whether the audited request actually did what it set out to do. A rejected attempt is as worth recording as a successful one — more so, for a security review. */
export const AUDIT_OUTCOMES = ['success', 'failure'] as const;
export type AuditOutcome = (typeof AUDIT_OUTCOMES)[number];

export const auditLog = pgTable(
  'audit_log',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => tenants.id, { onDelete: 'cascade' }),
    /** Supabase Auth user id. No FK — there is no local users table. Resolved to an email at read time, never stored as one. */
    actorUserId: text('actor_user_id').notNull(),
    /** The actor's app role as it was at the time of the action, not as it is now. A role change later must not rewrite history. */
    actorRole: text('actor_role'),
    method: text('method').notNull(),
    /**
     * The route PATTERN (`/knowledge-base/documents/:id`), not the resolved
     * path. Storing the pattern is what makes "show me every document
     * deletion" a grouping rather than a regex over uuids; the specific id
     * lives in `targetId`.
     */
    route: text('route').notNull(),
    /** The primary path parameter, when the route has one — the thing acted upon. */
    targetId: text('target_id'),
    statusCode: integer('status_code').notNull(),
    outcome: text('outcome').notNull().$type<AuditOutcome>(),
    /**
     * Human-readable description of what actually changed, when the handler
     * chose to say. Null is a normal, expected state: the interceptor records
     * every admin action whether or not anyone enriched it, which is what
     * makes the log complete. Enrichment makes an entry legible; its absence
     * never makes one missing.
     */
    detail: text('detail'),
    /**
     * QA 2026-10-05: the catalogue key `detail` was rendered from
     * (audit/audit-detail-catalog.ts) and the values interpolated into it, so
     * the console can show the entry in the operator's language. Both null
     * when the handler gave no description, and on rows written before
     * migration 0069. Insert-only like every other column here.
     */
    detailKey: text('detail_key'),
    detailParams:
      jsonb('detail_params').$type<Record<string, string | number>>(),
    createdAt: timestamp('created_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    // The only read pattern: one tenant's history, newest first. Without this
    // every page of the log is a scan plus a sort over the whole tenant.
    index('audit_log_tenant_created_idx').on(
      table.tenantId,
      table.createdAt.desc(),
    ),
  ],
).enableRLS();
