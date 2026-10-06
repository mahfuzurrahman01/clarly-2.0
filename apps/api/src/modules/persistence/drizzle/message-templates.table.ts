// F12: reusable message bodies a human sends from the console.
//
// Two kinds live in one table because they are the same object to the person
// picking one — a named body with placeholders — and differ only in how it
// leaves the building:
//
//   - `whatsapp_template`: pre-registered with Meta and the ONLY thing that
//     sends outside the 24-hour customer service window. Its `name` and
//     `language` are not ours to invent: they must match a template approved
//     in the tenant's WhatsApp Business account verbatim, or Meta rejects the
//     send. That is why `approvalStatus` exists and why it defaults to
//     `pending` rather than `approved` — claiming approval we have not
//     verified turns a send failure into a mystery.
//   - `canned_reply`: our own saved text, free-form, only valid INSIDE the
//     window. No Meta involvement, so the approval columns stay null.
//
// Placeholders are Meta's `{{1}}`, `{{2}}` positional form for both kinds, so
// one renderer serves both and a canned reply can be promoted to a WhatsApp
// template later without rewriting its body.
import {
  pgTable,
  uuid,
  text,
  jsonb,
  timestamp,
  unique,
} from 'drizzle-orm/pg-core';
import { tenants } from './tenants.table';

export const TEMPLATE_KINDS = ['whatsapp_template', 'canned_reply'] as const;
export type TemplateKind = (typeof TEMPLATE_KINDS)[number];

/**
 * Meta's own categories. Sending a UTILITY template for marketing content is
 * a policy violation against the tenant's WABA, not against us, so the value
 * is recorded rather than inferred.
 */
export const TEMPLATE_CATEGORIES = [
  'UTILITY',
  'MARKETING',
  'AUTHENTICATION',
] as const;
export type TemplateCategory = (typeof TEMPLATE_CATEGORIES)[number];

/**
 * Mirrors Meta's template review states, plus `local` for a canned reply that
 * never goes through review at all. `pending` is the honest default for a
 * newly-registered WhatsApp template: we know the tenant typed it, we do not
 * know Meta accepted it until a sync says so.
 */
export const TEMPLATE_APPROVAL_STATUSES = [
  'local',
  'pending',
  'approved',
  'rejected',
  'paused',
  'disabled',
] as const;
export type TemplateApprovalStatus =
  (typeof TEMPLATE_APPROVAL_STATUSES)[number];

/** One placeholder in the body, in positional order. `example` is what the console shows a person filling the template in — a bare "{{2}}" tells them nothing. */
export interface TemplateVariable {
  /** 1-based, matching the `{{n}}` it fills. */
  position: number;
  label: string;
  example: string | null;
}

export const messageTemplates = pgTable(
  'message_templates',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => tenants.id, { onDelete: 'cascade' }),
    kind: text('kind').notNull().$type<TemplateKind>(),
    /** For a WhatsApp template this is Meta's template name (lowercase, underscores) and must match theirs exactly. For a canned reply it is just a label a person recognises. */
    name: text('name').notNull(),
    /** Meta language code (`en_US`, `bn`). Meta treats one name in two languages as two templates, which is why it is part of the uniqueness key. */
    language: text('language').notNull().default('en'),
    category: text('category').$type<TemplateCategory>(),
    /** The text, with `{{1}}`-style placeholders. Stored as authored so the console can show a tenant what Meta approved. */
    body: text('body').notNull(),
    variables: jsonb('variables')
      .notNull()
      .default('[]')
      .$type<TemplateVariable[]>(),
    approvalStatus: text('approval_status')
      .notNull()
      .default('local')
      .$type<TemplateApprovalStatus>(),
    /** Meta's reason for a rejection, shown verbatim — paraphrasing it costs the tenant the one clue they have for fixing the template. */
    approvalDetail: text('approval_detail'),
    /**
     * F19 (D2, migration 0062): the WABA this template is approved on.
     *
     * Template approval is per-WhatsApp-Business-Account: a template approved
     * on WABA A does not exist for a number on WABA B, and sending it from
     * that number fails at Meta. D2's fifth authoring check compares this
     * against `whatsapp_numbers.waba_id` for the campaign's sending number —
     * a comparison that was unenforceable until this column existed.
     *
     * NULLABLE, and null BLOCKS the send (fail-closed, like every other D4
     * gate): a template whose WABA we have never established is not one we
     * can prove is sendable from any particular number. It is written by
     * `TemplateSyncService` from the number whose listing reported the
     * template, and deliberately left null when two WABAs report the same
     * name/language — an ambiguous answer is not an answer. A canned reply
     * has no WABA at all and never reaches this gate (`kind` refuses it
     * first).
     */
    wabaId: text('waba_id'),
    /** Last time a sync reconciled `approvalStatus` against the BSP. Null means never — the status is what the tenant asserted, not what Meta says. */
    syncedAt: timestamp('synced_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  // Uniqueness is (tenant, kind, name, language) rather than (tenant, name):
  // a tenant legitimately has one `order_shipped` template per language, and
  // a canned reply may share a name with a WhatsApp template it was promoted
  // from.
  (table) => [
    unique().on(table.tenantId, table.kind, table.name, table.language),
    // F19 (D2): lets `campaigns.(tenant_id, template_id)` hang a COMPOSITE FK
    // off this table — the same trick `customer_labels` uses off `customers`
    // — so a campaign in tenant B cannot reference tenant A's template even
    // though the bare id really exists. Redundant for uniqueness (`id` is
    // already the primary key).
    unique('message_templates_tenant_id_id_unique').on(
      table.tenantId,
      table.id,
    ),
  ],
).enableRLS();
