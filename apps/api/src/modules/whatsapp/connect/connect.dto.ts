// Channel/connect (WhatsappModule): request/response shapes for the connect API.
import { createZodDto } from 'nestjs-zod';
import { z } from 'zod';
import { WHATSAPP_CONNECTION_STATES } from '../../persistence/drizzle/schema';

const connectionStateSchema = z
  .enum(WHATSAPP_CONNECTION_STATES)
  .describe(
    "Gulf D5 connection state. 'active' sends and receives; 'reconnect_required' (token dead or number not registered) and 'disconnected' (WABA deleted, unshared or offboarded) need the tenant admin to connect again; 'restricted' is Meta blocking sends (policy, payment) and clears when Meta lifts it. See connectionError.",
  );

/** Gulf T3: what a connect returns and every read carries. */
const connectionSummarySchema = z.object({
  id: z.string().uuid(),
  phoneNumberId: z.string(),
  connectionState: connectionStateSchema,
  connectionError: z
    .string()
    .nullable()
    .describe(
      'What the tenant admin must do to fix a non-active number. Null while active.',
    ),
});

const healthIssueSchema = z.object({
  entityType: z
    .string()
    .describe(
      "Meta's node the problem is on: PHONE_NUMBER, WABA, BUSINESS or APP.",
    ),
  severity: z.enum(['BLOCKED', 'LIMITED']),
  errorCode: z.number().int().nullable(),
  description: z.string().describe("Meta's own description. Show as-is."),
  possibleSolution: z.string().nullable(),
});

/**
 * Gulf T5 (D5): number health. Meta's own values, verbatim (a new Meta value
 * is passed through, never mapped away). Every field is null until a
 * webhook or the daily reconcile has reported it.
 */
const numberHealthSchema = z.object({
  displayPhoneNumber: z
    .string()
    .nullable()
    .describe('Digits only, country code first (e.g. 15550783881).'),
  verifiedName: z
    .string()
    .nullable()
    .describe('The display name Meta shows for the number.'),
  qualityRating: z
    .string()
    .nullable()
    .describe('GREEN | YELLOW | RED | NA | UNKNOWN.'),
  messagingLimitTier: z
    .string()
    .nullable()
    .describe(
      'TIER_50 | TIER_250 | TIER_2K | TIER_10K | TIER_100K | TIER_UNLIMITED | TIER_NOT_SET. Per business portfolio.',
    ),
  nameStatus: z
    .string()
    .nullable()
    .describe(
      'Display-name review: APPROVED | AVAILABLE_WITHOUT_REVIEW | PENDING_REVIEW | DECLINED | EXPIRED | NONE.',
    ),
  paymentMethodAttached: z
    .boolean()
    .nullable()
    .describe(
      'False: the WABA has no payment method in Meta, so paid (template) messages will fail. Null: not read yet.',
    ),
  messagingHealth: z
    .string()
    .nullable()
    .describe("Meta's overall health_status: AVAILABLE | LIMITED | BLOCKED."),
  healthIssues: z
    .array(healthIssueSchema)
    .describe('Every BLOCKED/LIMITED reason from the last health check.'),
  lastHealthCheckAt: z
    .string()
    .datetime()
    .nullable()
    .describe('When the daily reconcile last read this number from Meta.'),
});

export const connectedNumberSchema =
  connectionSummarySchema.merge(numberHealthSchema);
export type ConnectedNumber = z.infer<typeof connectedNumberSchema>;
export class ConnectedNumberDto extends createZodDto(connectedNumberSchema) {}

/** Meta Graph ids are numeric strings; anything else is refused before a Graph call is spent on it. */
const graphIdSchema = z
  .string()
  .regex(/^\d{1,32}$/, 'must be a numeric Meta id');

/**
 * Gulf T3 (D3): what the browser forwards after the Embedded Signup popup
 * closes. `code` comes from FB.login's authResponse; `wabaId` and
 * `phoneNumberId` from the `WA_EMBEDDED_SIGNUP` session-logging message
 * (the code does not carry them). None of the ids is trusted: the server
 * checks both against what Meta says the exchanged token may reach.
 */
export const embeddedSignupBodySchema = z
  .object({
    code: z.string().trim().min(1).max(2048),
    wabaId: graphIdSchema,
    /**
     * Optional for the WhatsApp Business app (coexistence) flow: its
     * FINISH_WHATSAPP_BUSINESS_APP_ONBOARDING message carries only
     * `waba_id`. When omitted the WABA must hold exactly one number.
     */
    phoneNumberId: graphIdSchema.optional(),
    /**
     * D15c existing-PIN path: the number's current two-step verification
     * PIN, when a previous attempt came back `reconnect_required` because
     * the number already had one. Omit it normally; the server generates
     * the PIN.
     */
    pin: z
      .string()
      .regex(/^\d{6}$/, 'must be exactly 6 digits')
      .optional(),
  })
  .strict();
export type EmbeddedSignupBody = z.infer<typeof embeddedSignupBodySchema>;
export class EmbeddedSignupBodyDto extends createZodDto(
  embeddedSignupBodySchema,
) {}

export const embeddedSignupResponseSchema = connectionSummarySchema.extend({
  /** D13: true when the number stays on the WhatsApp Business app too (coexistence); its phone-app messages appear in the inbox as human-sent. */
  coexistence: z.boolean(),
});
export type EmbeddedSignupResult = z.infer<typeof embeddedSignupResponseSchema>;
export class EmbeddedSignupResponseDto extends createZodDto(
  embeddedSignupResponseSchema,
) {}
