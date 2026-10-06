// Feature 2 (T6): one row per tenant-connected WABA number.
// `phoneNumberId` is the Meta Cloud API webhook field (D14: Meta is the only
// WhatsApp provider) — see docs/decisions/T0-bsp-selection.md. This table is deliberately looked up
// BEFORE any tenant context exists (that's the whole point: resolving
// phone_number_id -> tenant_id IS how tenant context gets established for
// an inbound webhook), so — like `tenants` — it is NOT RLS-scoped for the
// resolution read path; PersistenceService.runAdminQuery() is the
// sanctioned way to run that one lookup, and it must only ever select
// `tenantId`, never `bspCredentialsEncrypted`, from that path. Once a
// tenant IS known, any further read of this table (e.g. an onboarding UI
// listing a tenant's own connected numbers) should still prefer
// withTenantTx() for defense in depth even though this table has no RLS
// policy of its own — see docs/decisions/F2-channel.md.
import {
  pgTable,
  uuid,
  text,
  timestamp,
  jsonb,
  boolean,
} from 'drizzle-orm/pg-core';
import { tenants } from './tenants.table';

/**
 * Gulf T5 (D5): one problem Meta reports about a number's ability to send,
 * from the `health_status` field of `GET /{phone-number-id}`. Stored as Meta
 * words it (description + possible solution) so the console can show the
 * fix, e.g. a missing payment method on the WABA, without us keeping a copy
 * of Meta's error catalogue.
 */
export interface WhatsappHealthIssue {
  /** Meta's node the problem is on: PHONE_NUMBER, WABA, BUSINESS or APP. */
  entityType: string;
  /** BLOCKED (cannot send) or LIMITED (can send, with a limitation). */
  severity: 'BLOCKED' | 'LIMITED';
  /** Meta's error code for a BLOCKED node; null for LIMITED. */
  errorCode: number | null;
  description: string;
  possibleSolution: string | null;
}

/**
 * Gulf D5's shared WhatsApp connection-state enum. T3 (Embedded Signup)
 * writes 'active' and 'reconnect_required' (a `register` that failed after
 * `subscribed_apps`); T5 adds the webhook/send-path/reconcile writers of
 * every state (see whatsapp/health/connection-state.policy.ts for the
 * transition rules). Enforced by a CHECK constraint
 * (migration 0048), so a typo cannot land a state the console cannot render.
 */
export const WHATSAPP_CONNECTION_STATES = [
  'active',
  'reconnect_required',
  'restricted',
  'disconnected',
] as const;
export type WhatsappConnectionState =
  (typeof WHATSAPP_CONNECTION_STATES)[number];

export const whatsappNumbers = pgTable('whatsapp_numbers', {
  id: uuid('id').primaryKey().defaultRandom(),
  tenantId: uuid('tenant_id')
    .notNull()
    .references(() => tenants.id, { onDelete: 'cascade' }),
  phoneNumberId: text('phone_number_id').notNull().unique(),
  /** AES-256-GCM ciphertext (see credentials-encryption.service.ts) — never stored/logged in plaintext. */
  bspCredentialsEncrypted: text('bsp_credentials_encrypted').notNull(),
  /** See WHATSAPP_CONNECTION_STATES. Defaults to 'active' so every row that predates T3 keeps its meaning. */
  connectionState: text('connection_state')
    .notNull()
    .default('active')
    .$type<WhatsappConnectionState>(),
  /** What the tenant admin must do to fix a non-active number, in words they can act on. Null while active. */
  connectionError: text('connection_error'),
  // ---- Gulf T5 (D5): number health, migration 0049 ----
  // Meta-owned vocabularies (quality rating, messaging-limit tier, name
  // status, health) are stored verbatim with no CHECK constraint: Meta adds
  // values without notice, and a CHECK would turn a new value into a failed
  // webhook. Null means "not yet reported".
  /**
   * The WABA this number belongs to. Not a secret (the same id is in every
   * WABA webhook's `entry.id`); it is how an `account_update` webhook, which
   * names only the WABA, finds its numbers. Written at connect time and
   * backfilled by the reconcile for rows connected before T5.
   */
  wabaId: text('waba_id'),
  /** Digits only (Meta formats it differently per API). How the quality/name webhooks, which carry no phone_number_id, find the number. */
  displayPhoneNumber: text('display_phone_number'),
  /** The display name Meta shows for the number (`verified_name`). */
  verifiedName: text('verified_name'),
  /**
   * Whether the WABA has a payment method: Meta's WABA `primary_funding_id`
   * is set. Meta bills the tenant's own WABA for messages, so false means
   * paid (template) sends will fail. Null until the reconcile has read it.
   */
  paymentMethodAttached: boolean('payment_method_attached'),
  /** GREEN | YELLOW | RED | NA | UNKNOWN (Meta's `quality_rating`). Reconcile only: no current webhook carries it. */
  qualityRating: text('quality_rating'),
  /** TIER_50 | TIER_250 | TIER_2K | TIER_10K | TIER_100K | TIER_UNLIMITED | TIER_NOT_SET. Portfolio-level at Meta, so every number on a WABA carries the same value. */
  messagingLimitTier: text('messaging_limit_tier'),
  /** Display-name review state in Graph's `name_status` words: APPROVED | AVAILABLE_WITHOUT_REVIEW | PENDING_REVIEW | DECLINED | EXPIRED | NONE. */
  nameStatus: text('name_status'),
  /** Meta's overall `health_status.can_send_message`: AVAILABLE | LIMITED | BLOCKED. */
  messagingHealth: text('messaging_health'),
  /** Every BLOCKED/LIMITED entity from the last health check. Empty when healthy or never checked. */
  healthIssues: jsonb('health_issues')
    .$type<WhatsappHealthIssue[]>()
    .notNull()
    .default([]),
  /** When the daily reconcile last read this number's health from Meta successfully. */
  lastHealthCheckAt: timestamp('last_health_check_at', { withTimezone: true }),
  /**
   * hashMetaUserId() of the Meta user that owns the Embedded Signup business
   * token (`GET /me`). Lets Meta's deauthorize callback (Gulf T7) find the
   * numbers a removed app login connected. Null for rows connected before T5.
   */
  connectedByMetaUserHash: text('connected_by_meta_user_hash'),
  // ---- F19 (D4): business/WABA verification, feeds CampaignEligibilityService ----
  // Fed by the existing T5 daily reconcile's WABA read (extended field list),
  // not a new job or token. Meta-owned vocabulary, stored verbatim with no
  // CHECK constraint for the same reason as qualityRating etc above. Null
  // means "never read" and MUST be treated as blocked, never waved through
  // (see docs/decisions/F19-campaigns-broadcast.md D4).
  /** APPROVED | PENDING | REJECTED (Meta's WABA `account_review_status`). */
  wabaAccountReviewStatus: text('waba_account_review_status'),
  /** verified | not_verified | pending | failed (Meta's `owner_business_info.verification_status`). */
  businessVerificationStatus: text('business_verification_status'),
  createdAt: timestamp('created_at', { withTimezone: true })
    .notNull()
    .defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true })
    .notNull()
    .defaultNow(),
});
