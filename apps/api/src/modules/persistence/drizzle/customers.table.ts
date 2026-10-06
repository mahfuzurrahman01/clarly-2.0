// Feature 5 (T13): "Persistent customer profile — phone, name, tags, notes
// — shared across all conversations and tickets for that customer, not
// re-derived per conversation." One row per (tenant, phone) — same
// get-or-create-by-unique-key pattern as Feature 4's `conversations`
// table, so a second ticket/conversation for a phone number already seen
// reuses this row instead of creating a duplicate.
import {
  pgTable,
  uuid,
  text,
  jsonb,
  timestamp,
  unique,
} from 'drizzle-orm/pg-core';
import { tenants } from './tenants.table';
import type { ChannelKind } from '../../channel/ports/channel-kind';

/** `customer_keyword` — they typed STOP or similar. `admin` — someone set it in the console on their behalf, e.g. after a phone call. */
export const OPT_OUT_SOURCES = ['customer_keyword', 'admin'] as const;
export type OptOutSource = (typeof OPT_OUT_SOURCES)[number];

export const customers = pgTable(
  'customers',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => tenants.id, { onDelete: 'cascade' }),
    /**
     * Feature 16: which channel this identity belongs to. Part of the
     * identity key for the same reason it is on `conversations` — a
     * Messenger PSID is not a phone number, and two different people must
     * never collapse into one customer row because their ids happen to be
     * digit strings of similar shape.
     *
     * Note what this does NOT claim: the same human on WhatsApp and on
     * Instagram is two rows here, because Meta gives us no id that links
     * them. Inventing a link would be a privacy claim we cannot support.
     */
    channel: text('channel').notNull().default('whatsapp').$type<ChannelKind>(),
    /** The customer's channel-scoped identity. A phone number on WhatsApp; a PSID/IGSID on the Meta social channels. */
    phone: text('phone').notNull(),
    name: text('name'),
    tags: jsonb('tags').notNull().default('[]').$type<string[]>(),
    notes: text('notes'),
    /**
     * Set when this customer asked to stop hearing from us. Null means they
     * have not. Business-initiated messages (templates) and agent auto-replies
     * are refused while this is set; see CustomerConsentService for exactly
     * what is and is not blocked, and why.
     */
    optedOutAt: timestamp('opted_out_at', { withTimezone: true }),
    /** How the opt-out happened. A compliance question is never just "did they", it is "how do you know". */
    optOutSource: text('opt_out_source').$type<OptOutSource>(),
    /**
     * F19 (Open Question 2, resolved 2026-09-21): the narrower,
     * marketing-specific opt-out, distinct from the global `optedOutAt`
     * above. `CustomerConsentService.isMarketingOptedOut()` is true when
     * EITHER column is set — marketing consent inherits the global opt-out
     * rather than duplicating it. Set by the "STOP MARKETING"/"UNSUBSCRIBE"
     * inbound keyword handler, or manually via
     * `PATCH /customers/:id/marketing-consent`. There is no reverse
     * (customer-initiated) flow in v1: re-consent requires the customer to
     * message in first, matching WhatsApp's own marketing opt-in model.
     */
    marketingOptedOutAt: timestamp('marketing_opted_out_at', {
      withTimezone: true,
    }),
    createdAt: timestamp('created_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    // Feature 16 widened this from (tenant, phone) — see `channel` above.
    // Name pinned to the pre-Feature-16 auto-generated one so existing
    // `onConflictDoUpdate` targets keep resolving and the migration is an
    // in-place redefinition rather than a drop-and-rename dance.
    unique('customers_tenant_id_phone_unique').on(
      table.tenantId,
      table.channel,
      table.phone,
    ),
    // Redundant for uniqueness (`id` is already the primary key) — it exists
    // so `customer_labels` (Feature 18) can hang a COMPOSITE foreign key off
    // (tenant_id, id), which is what makes a cross-tenant customer reference
    // impossible in the database rather than only in a controller check. See
    // customer-labels.table.ts.
    unique('customers_tenant_id_id_unique').on(table.tenantId, table.id),
  ],
).enableRLS();
