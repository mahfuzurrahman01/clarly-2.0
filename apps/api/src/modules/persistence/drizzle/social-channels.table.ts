// Feature 16 (T22): one row per tenant-connected Meta social channel — a
// Facebook page (Messenger) or an Instagram professional account (IG DM).
//
// This is `whatsapp_numbers`' sibling and follows its pattern deliberately,
// down to the RLS decision: it is looked up BEFORE any tenant context exists
// (resolving page_id/ig_id -> tenant_id IS how tenant context gets
// established for an inbound Meta webhook), so the resolution read path is
// NOT RLS-scoped. `PersistenceService.runAdminQuery()` is the sanctioned way
// to run that one lookup and it must only ever select `tenantId` +
// routing/state columns, never `credentialsEncrypted`. Once a tenant IS
// known, every further read filters by tenant explicitly (see
// SocialChannelDirectory) — that filter is the isolation boundary, not
// decoration.
//
// Two id columns, because Meta's two products do not agree on which id is
// which:
//   - `channelAccountId` is the id INBOUND webhooks arrive under —
//     `entry[].id`. For Messenger that is the page id; for Instagram it is
//     the Instagram professional account id.
//   - `pageId` is the Facebook page whose access token authorizes OUTBOUND
//     sends. For Messenger these are the same value; for Instagram they are
//     not, and an Instagram DM is still sent through the linked page.
// Collapsing them into one column works right up until the first Instagram
// send, which is far too late to discover it.
import { sql } from 'drizzle-orm';
import { pgTable, uuid, text, timestamp, index } from 'drizzle-orm/pg-core';
import { tenants } from './tenants.table';
import type { ChannelKind } from '../../channel/ports/channel-kind';

/**
 * Whether this channel can currently send.
 *
 * 'connected'          — normal.
 * 'reconnect_required' — the stored token expired and could not be
 *                        refreshed. Feature 16's own exit criterion: this
 *                        state exists so a dead token degrades ONE channel
 *                        visibly instead of silently dropping a tenant's
 *                        messages. Inbound is still ingested and still
 *                        reaches a human; only automated sending stops.
 */
export const SOCIAL_CHANNEL_CONNECTION_STATES = [
  'connected',
  'reconnect_required',
] as const;
export type SocialChannelConnectionState =
  (typeof SOCIAL_CHANNEL_CONNECTION_STATES)[number];

export const socialChannels = pgTable(
  'social_channels',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => tenants.id, { onDelete: 'cascade' }),
    /** 'messenger' | 'instagram'. Never 'whatsapp' — that lives in `whatsapp_numbers`, which has genuinely different columns (WABA id, template state). */
    channel: text('channel').notNull().$type<ChannelKind>(),
    /** The id inbound webhooks arrive under. Unique platform-wide: one Meta account belongs to exactly one tenant. */
    channelAccountId: text('channel_account_id').notNull().unique(),
    /** The Facebook page whose token authorizes sends. Equals channelAccountId for Messenger. */
    pageId: text('page_id').notNull(),
    /** Human-readable, for the console's channel list. Never used for routing. */
    displayName: text('display_name'),
    /** AES-256-GCM ciphertext (BspCredentialsEncryptionService) — the page access token and friends. Never stored or logged in plaintext. */
    credentialsEncrypted: text('credentials_encrypted').notNull(),
    /**
     * When the stored long-lived token stops working. Null means Meta did not
     * tell us (system-user tokens can be non-expiring) — treated as "cannot
     * be pre-emptively refreshed", never as "safe forever".
     */
    tokenExpiresAt: timestamp('token_expires_at', { withTimezone: true }),
    /** Last successful refresh. Null until one happens. Diagnostic only. */
    tokenRefreshedAt: timestamp('token_refreshed_at', { withTimezone: true }),
    /** See SOCIAL_CHANNEL_CONNECTION_STATES. */
    connectionState: text('connection_state')
      .notNull()
      .default('connected')
      .$type<SocialChannelConnectionState>(),
    /** Why it needs reconnecting, in words a tenant admin can act on. Null while connected. */
    connectionError: text('connection_error'),
    /**
     * Gulf T7 (D7): hashMetaUserId() of the Facebook user whose login granted
     * this channel's tokens. The ONLY link from Meta's deauthorize and
     * data-deletion callbacks (which name a user, never a page) back to the
     * channels that user connected. Hashed because it is only ever matched.
     * Null for rows connected before T4's server-side handshake, which is what
     * first learns the id (`/me`) — those rows cannot be reached by either
     * callback until they are reconnected.
     */
    connectedByMetaUserHash: text('connected_by_meta_user_hash'),
    createdAt: timestamp('created_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    index('social_channels_tenant_id_idx').on(table.tenantId),
    // The token-refresh sweep's access path: "which channels expire soon".
    index('social_channels_token_expires_at_idx').on(table.tokenExpiresAt),
    // Deauthorize / data-deletion callbacks: "which channels did this Meta
    // user connect". Partial — most legacy rows have no user recorded.
    index('social_channels_connected_by_meta_user_idx')
      .on(table.connectedByMetaUserHash)
      .where(sql`${table.connectedByMetaUserHash} IS NOT NULL`),
  ],
);
