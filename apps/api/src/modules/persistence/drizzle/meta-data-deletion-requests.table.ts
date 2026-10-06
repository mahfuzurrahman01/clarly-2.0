// Gulf T7 (D7): one row per Data Deletion Request Meta sends us on a user's
// behalf (Facebook Settings -> Apps and Websites -> Remove -> "delete data").
//
// Platform-level, like `social_channels` and `stripe_customer_tenant_map`: a
// request is about a Meta user, not a tenant, and it arrives with no tenant
// context at all. So no tenant_id and no RLS. Two public reads exist and both
// are narrow: the callback (verified signed_request) and the status page,
// which looks up by an unguessable confirmation code and returns only status
// + timestamps.
//
// The Meta user id is stored HASHED (see hashMetaUserId). The only thing this
// table ever does with it is match it, and keeping a plaintext copy of the id
// of someone who asked us to delete their data would be a strange way to
// honour the request.
import {
  pgTable,
  uuid,
  text,
  integer,
  timestamp,
  index,
} from 'drizzle-orm/pg-core';

/**
 * 'pending'   — recorded, deletion not finished yet.
 * 'completed' — everything we hold keyed by that Meta user is gone.
 * 'failed'    — the deletion threw. Logged at error level for on-call; a
 *               replay of the same signed_request re-runs it.
 */
export const META_DATA_DELETION_STATUSES = [
  'pending',
  'completed',
  'failed',
] as const;
export type MetaDataDeletionStatus =
  (typeof META_DATA_DELETION_STATUSES)[number];

export const metaDataDeletionRequests = pgTable(
  'meta_data_deletion_requests',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    /** Returned to Meta and shown to the user. Random, unguessable — it is the only key the public status page accepts. */
    confirmationCode: text('confirmation_code').notNull().unique(),
    /** hashMetaUserId(app-scoped user id). Never the plaintext id. */
    metaUserIdHash: text('meta_user_id_hash').notNull(),
    /**
     * SHA-256 of the exact signed_request string. Meta re-delivering the SAME
     * request gets the SAME confirmation code back instead of a second row;
     * a genuinely new request for the same user gets a new row.
     */
    signedRequestHash: text('signed_request_hash').notNull().unique(),
    status: text('status')
      .notNull()
      .default('pending')
      .$type<MetaDataDeletionStatus>(),
    /** How many connected social channels had credentials scrubbed. Evidence, not a contract. */
    socialChannelsScrubbed: integer('social_channels_scrubbed')
      .notNull()
      .default(0),
    /** Internal only — never returned by the status endpoint. */
    error: text('error'),
    requestedAt: timestamp('requested_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
    completedAt: timestamp('completed_at', { withTimezone: true }),
  },
  (table) => [
    index('meta_data_deletion_requests_user_idx').on(table.metaUserIdHash),
  ],
);
