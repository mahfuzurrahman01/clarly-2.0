// Channel (WhatsappModule, Gulf T5 / D5): the WABA health webhook fields
// Meta delivers on /webhooks/whatsapp next to `messages`:
//   - account_update               (WABA-level: deleted, restricted, banned,
//                                   unshared, our app uninstalled, ...)
//   - phone_number_quality_update  (messaging limit / throughput changes)
//   - phone_number_name_update     (display-name review outcome)
// Shapes per Meta's webhooks reference (developers.facebook.com, checked
// 2026-09-19). Meta's words are translated to ours here and nowhere else.
//
// Pure and never throws: this runs after the inbound-message ingest on a
// signature-verified body, and a malformed or unknown change is skipped, not
// allowed to fail the delivery (Meta would redeliver it forever). None of
// these payloads carries a phone_number_id: account events name the WABA;
// the other two name the WABA (entry.id) plus the display number.
import { z } from 'zod';
import {
  CONNECTION_REASONS,
  degrade,
  restore,
  type ConnectionTransition,
} from './connection-state.policy';

export type WabaHealthEvent =
  | {
      kind: 'connection';
      wabaId: string;
      /** Meta's `account_update` event name, for logs. */
      event: string;
      transition: ConnectionTransition;
    }
  | {
      kind: 'messaging_limit';
      wabaId: string;
      /** TIER_*: Meta's portfolio-level messaging limit. */
      tier: string;
    }
  | {
      kind: 'name_status';
      wabaId: string;
      /** Digits only. */
      displayPhoneNumber: string;
      /** In Graph's `name_status` vocabulary, so webhook and reconcile agree. */
      nameStatus: string;
    };

export interface WabaHealthParseOptions {
  /** Our Meta app id: PARTNER_APP_UNINSTALLED about another partner's app is not ours to act on. */
  appId: string;
}

const envelopeSchema = z.object({
  object: z.literal('whatsapp_business_account'),
  entry: z.array(
    z.object({
      id: z.string(),
      changes: z.array(z.object({ field: z.string(), value: z.unknown() })),
    }),
  ),
});

const accountUpdateSchema = z.object({
  event: z.string(),
  waba_info: z
    .object({
      waba_id: z.string().optional(),
      partner_app_id: z.string().optional(),
    })
    .optional(),
  ban_info: z.object({ waba_ban_state: z.string().optional() }).optional(),
  restriction_info: z
    .array(
      z.object({
        restriction_type: z.string(),
        expiration: z.number().optional(),
      }),
    )
    .optional(),
});

const qualityUpdateSchema = z.object({
  event: z.string().optional(),
  current_limit: z.string().optional(),
  max_daily_conversations_per_business: z.string().optional(),
});

const nameUpdateSchema = z.object({
  display_phone_number: z.string(),
  decision: z.string(),
});

const TIER_PATTERN = /^TIER_[A-Z0-9_]+$/;

/** `phone_number_name_update.decision` -> Graph `name_status`. */
const NAME_DECISIONS: Readonly<Record<string, string>> = {
  APPROVED: 'APPROVED',
  REJECTED: 'DECLINED',
  PENDING: 'PENDING_REVIEW',
  DEFERRED: 'PENDING_REVIEW',
};

/** What each documented restriction stops the business doing, in words a tenant reads. */
const RESTRICTION_PHRASES: Readonly<Record<string, string>> = {
  RESTRICTED_BIZ_INITIATED_MESSAGING:
    'start conversations with customers (templates)',
  RESTRICTED_CUSTOMER_INITIATED_MESSAGING: 'reply to customers',
  RESTRICTED_ADD_PHONE_NUMBER_ACTION: 'add phone numbers',
  RESTRICTED_UTILITY_TEMPLATES: 'create utility templates',
  RESTRICTED_DIRECT_SEND_UTILITY_TEMPLATES: 'send utility templates',
  RESTRICTED_BIZ_INITIATED_AND_USER_INITIATED_CALLING: 'make or receive calls',
  RESTRICTED_BUSINESS_INITIATED_CALLING: 'make calls',
  RESTRICTED_USER_INITIATED_CALLING: 'receive calls',
  RESTRICTED_USER_INITIATED_CALLING_CALL_BUTTON_HIDDEN: 'show the call button',
};

/** Digits only: Meta sends `15550783881` in webhooks and `+1 555-078-3881` from Graph. */
export function normalizeDisplayPhoneNumber(value: string): string {
  return value.replace(/\D/g, '');
}

export function parseWabaHealthWebhook(
  rawBody: string | Buffer,
  options: WabaHealthParseOptions,
): WabaHealthEvent[] {
  let json: unknown;
  try {
    json = JSON.parse(
      typeof rawBody === 'string' ? rawBody : rawBody.toString('utf8'),
    );
  } catch {
    return [];
  }
  const envelope = envelopeSchema.safeParse(json);
  if (!envelope.success) return [];

  return envelope.data.entry.flatMap((entry) =>
    entry.changes.flatMap((change) =>
      parseChange(entry.id, change.field, change.value, options),
    ),
  );
}

function parseChange(
  entryId: string,
  field: string,
  value: unknown,
  options: WabaHealthParseOptions,
): WabaHealthEvent[] {
  switch (field) {
    case 'account_update':
      return parseAccountUpdate(entryId, value, options);
    case 'phone_number_quality_update':
      return parseQualityUpdate(entryId, value);
    case 'phone_number_name_update':
      return parseNameUpdate(entryId, value);
    default:
      return [];
  }
}

function parseAccountUpdate(
  entryId: string,
  value: unknown,
  options: WabaHealthParseOptions,
): WabaHealthEvent[] {
  const parsed = accountUpdateSchema.safeParse(value);
  if (!parsed.success) return [];
  const update = parsed.data;
  // PARTNER_* events arrive on the PARTNER's entry (our business id); the
  // customer's WABA is in waba_info. Every other event's entry.id IS the WABA.
  const wabaId = update.waba_info?.waba_id ?? entryId;
  const transition = accountTransition(update, options);
  return transition
    ? [{ kind: 'connection', wabaId, event: update.event, transition }]
    : [];
}

function accountTransition(
  update: z.infer<typeof accountUpdateSchema>,
  options: WabaHealthParseOptions,
): ConnectionTransition | null {
  switch (update.event) {
    case 'ACCOUNT_DELETED':
      return degrade('disconnected', CONNECTION_REASONS.wabaDeleted);
    case 'PARTNER_REMOVED':
      return degrade('disconnected', CONNECTION_REASONS.partnerRemoved);
    case 'ACCOUNT_OFFBOARDED':
      return degrade('disconnected', CONNECTION_REASONS.offboarded);
    case 'ACCOUNT_RECONNECTED':
      return restore(['disconnected']);
    case 'PARTNER_APP_UNINSTALLED': {
      const appId = update.waba_info?.partner_app_id;
      if (appId !== undefined && appId !== options.appId) return null;
      return degrade('reconnect_required', CONNECTION_REASONS.appUninstalled);
    }
    case 'ACCOUNT_RESTRICTION':
      return degrade('restricted', restrictionReason(update.restriction_info));
    case 'DISABLED_UPDATE': {
      const state = update.ban_info?.waba_ban_state;
      if (state === 'DISABLE') {
        return degrade('restricted', CONNECTION_REASONS.wabaDisabled);
      }
      if (state === 'REINSTATE') return restore(['restricted']);
      // SCHEDULE_FOR_DISABLE: still sending today. The daily reconcile's
      // health_status read shows any limitation that comes with it.
      return null;
    }
    default:
      return null;
  }
}

function restrictionReason(
  restrictions: z.infer<typeof accountUpdateSchema>['restriction_info'] = [],
): string {
  const phrases = restrictions.map(
    (r) => RESTRICTION_PHRASES[r.restriction_type] ?? r.restriction_type,
  );
  const expirations = restrictions
    .map((r) => r.expiration)
    .filter((e): e is number => typeof e === 'number' && e > 0);
  const what =
    phrases.length > 0 ? `: this account cannot ${phrases.join(', ')}` : '';
  const until =
    expirations.length > 0
      ? ` until ${new Date(Math.max(...expirations) * 1000).toISOString().slice(0, 10)}`
      : '';
  return `Meta restricted this WhatsApp Business account for a policy violation${what}${until}. Review it in WhatsApp Manager.`;
}

function parseQualityUpdate(
  entryId: string,
  value: unknown,
): WabaHealthEvent[] {
  const parsed = qualityUpdateSchema.safeParse(value);
  if (!parsed.success) return [];
  const update = parsed.data;
  // `current_limit` also reports THROUGHPUT (TIER_UNLIMITED on a
  // THROUGHPUT_UPGRADE), which is not a messaging limit. The explicit field
  // is always a messaging limit; the deprecated one only outside throughput
  // and onboarding events.
  const tier =
    update.max_daily_conversations_per_business ??
    (update.event === 'THROUGHPUT_UPGRADE' || update.event === 'ONBOARDING'
      ? undefined
      : update.current_limit);
  if (tier === undefined || !TIER_PATTERN.test(tier)) return [];
  return [{ kind: 'messaging_limit', wabaId: entryId, tier }];
}

function parseNameUpdate(entryId: string, value: unknown): WabaHealthEvent[] {
  const parsed = nameUpdateSchema.safeParse(value);
  if (!parsed.success) return [];
  const nameStatus = NAME_DECISIONS[parsed.data.decision];
  const displayPhoneNumber = normalizeDisplayPhoneNumber(
    parsed.data.display_phone_number,
  );
  if (!nameStatus || displayPhoneNumber.length === 0) return [];
  return [
    { kind: 'name_status', wabaId: entryId, displayPhoneNumber, nameStatus },
  ];
}
