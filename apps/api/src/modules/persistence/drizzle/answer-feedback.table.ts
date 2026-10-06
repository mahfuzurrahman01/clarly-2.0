// Product shell (InboxModule): was that a good answer?
//
// The cheapest possible collector for the eval corpus TODOS.md gates on
// "real tenant data" — a human who is already reading the transcript marking
// one reply good or bad. Not collecting it from day one keeps that gate shut
// longer than it needs to be.
//
// One rating per message per tenant, so a second opinion REPLACES the first
// rather than stacking: the question is "is this answer good", which has one
// current answer, not a tally.
import { pgTable, uuid, text, timestamp, unique } from 'drizzle-orm/pg-core';
import { tenants } from './tenants.table';
import { messages } from './messages.table';

export const FEEDBACK_RATINGS = ['up', 'down'] as const;
export type FeedbackRating = (typeof FEEDBACK_RATINGS)[number];

export const answerFeedback = pgTable(
  'answer_feedback',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => tenants.id, { onDelete: 'cascade' }),
    /** The agent reply being rated. Cascades: a purged transcript takes its ratings with it, since a rating with no answer attached teaches nothing. */
    messageId: uuid('message_id')
      .notNull()
      .references(() => messages.id, { onDelete: 'cascade' }),
    rating: text('rating').notNull(),
    /** Why it was wrong, in the rater's words. The single most useful field for building an eval case later, and the one a thumbs-down alone cannot give. */
    note: text('note'),
    /** Who rated it. Not an FK: users live in Supabase auth, outside this database. */
    ratedBy: uuid('rated_by'),
    createdAt: timestamp('created_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [unique().on(table.tenantId, table.messageId)],
).enableRLS();
