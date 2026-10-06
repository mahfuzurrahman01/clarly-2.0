// Channel (WhatsappModule, Gulf T5 / D5): reads one number's health from
// Graph — `GET /{phone-number-id}?fields=...` through the shared
// MetaGraphClient (D8), with the number's own business token.
//
// Fields (developers.facebook.com, checked 2026-09-19):
//   - quality_rating: GREEN | YELLOW | RED | NA (UNKNOWN also seen)
//   - whatsapp_business_manager_messaging_limit: TIER_*; replaces the
//     deprecated `messaging_limit_tier`
//   - name_status: display-name review state. Meta marks it beta ("not
//     available to all developers"), so a code-100 "nonexisting field"
//     refusal is retried once without it rather than failing the read.
//   - health_status: overall can_send_message plus per-entity errors
//     (BLOCKED) / additional_info (LIMITED). This is where a missing WABA
//     payment method or a policy block surfaces.
//   - display_phone_number: lets the name webhook find the number.
//   - verified_name: the display name customers see.
// Plus one WABA read, `GET /{waba-id}?fields=primary_funding_id` ("Primary
// funding ID for the WhatsApp Business Account paid service"): set means a
// payment method is attached. Meta bills the tenant's own WABA, so this
// drives the "add a payment method in Meta" banner. A failed WABA read
// leaves it unknown (null) rather than failing the whole check.
//
// Parsed leniently: a field Meta omits or reshapes becomes null, never a
// failed read. Graph errors propagate (the reconcile decides what a revoked
// token means).
import { Injectable } from '@nestjs/common';
import { z } from 'zod';
import {
  MetaGraphClient,
  MetaGraphError,
} from '../../meta-graph/meta-graph.module';
import type { WhatsappHealthIssue } from '../../persistence/drizzle/schema';
import { normalizeDisplayPhoneNumber } from './waba-health-webhook.parser';
import type { WhatsappHealthSnapshot } from './whatsapp-number-health.store';

export const HEALTH_FIELDS_WITHOUT_NAME_STATUS =
  'display_phone_number,verified_name,quality_rating,whatsapp_business_manager_messaging_limit,health_status';
// F19 (D4): the same single WABA read now also carries the two verification
// values CampaignEligibilityService gates a broadcast on — no new job, no new
// token, no new schedule. Parsed with the same lenient `optionalString`
// treatment as every other Meta-owned vocabulary in this file (stored
// verbatim, no CHECK constraint: Meta adds values without notice).
export const WABA_FIELDS =
  'primary_funding_id,account_review_status,owner_business_info{verification_status}';
export const HEALTH_FIELDS = `${HEALTH_FIELDS_WITHOUT_NAME_STATUS},name_status`;

/** Graph "invalid parameter / nonexisting field". */
const INVALID_FIELD_CODE = 100;

const optionalString = z
  .string()
  .nullish()
  .catch(null)
  .transform((value) => value ?? null);

const entitySchema = z.object({
  entity_type: z.string().catch('UNKNOWN'),
  can_send_message: z.string().optional().catch(undefined),
  additional_info: z.array(z.string()).optional().catch(undefined),
  errors: z
    .array(
      z.object({
        error_code: z.number().nullish().catch(null),
        error_description: z.string(),
        possible_solution: z.string().nullish().catch(null),
      }),
    )
    .optional()
    .catch(undefined),
});

const wabaSchema = z.object({
  primary_funding_id: optionalString,
  account_review_status: optionalString,
  owner_business_info: z
    .object({ verification_status: optionalString })
    .nullish()
    .catch(null),
});

/** What one WABA read reports. Every field null when the read failed — D4 treats null as blocked, never as benign. */
interface WabaFacts {
  paymentMethodAttached: boolean | null;
  accountReviewStatus: string | null;
  businessVerificationStatus: string | null;
}

const UNKNOWN_WABA: WabaFacts = {
  paymentMethodAttached: null,
  accountReviewStatus: null,
  businessVerificationStatus: null,
};

const responseSchema = z.object({
  display_phone_number: optionalString,
  verified_name: optionalString,
  quality_rating: optionalString,
  name_status: optionalString,
  whatsapp_business_manager_messaging_limit: optionalString,
  health_status: z
    .object({
      can_send_message: optionalString,
      entities: z.array(z.unknown()).catch([]).default([]),
    })
    .nullish()
    .catch(null),
});

@Injectable()
export class MetaPhoneNumberHealthReader {
  constructor(private readonly graph: MetaGraphClient) {}

  async read(
    phoneNumberId: string,
    wabaId: string | null,
    accessToken: string,
    checkedAt: Date,
  ): Promise<WhatsappHealthSnapshot> {
    const raw = await this.fetch(phoneNumberId, accessToken);
    const waba = wabaId
      ? await this.readWaba(wabaId, accessToken)
      : UNKNOWN_WABA;
    const parsed = responseSchema.safeParse(raw ?? {});
    const data = parsed.success ? parsed.data : responseSchema.parse({});

    return {
      qualityRating: data.quality_rating,
      messagingLimitTier: data.whatsapp_business_manager_messaging_limit,
      nameStatus: data.name_status,
      messagingHealth: data.health_status?.can_send_message ?? null,
      healthIssues: toIssues(data.health_status?.entities ?? []),
      displayPhoneNumber: data.display_phone_number
        ? normalizeDisplayPhoneNumber(data.display_phone_number) || null
        : null,
      verifiedName: data.verified_name,
      paymentMethodAttached: waba.paymentMethodAttached,
      wabaAccountReviewStatus: waba.accountReviewStatus,
      businessVerificationStatus: waba.businessVerificationStatus,
      checkedAt,
    };
  }

  private async readWaba(
    wabaId: string,
    accessToken: string,
  ): Promise<WabaFacts> {
    try {
      const raw = await this.graph.get(wabaId, accessToken, {
        fields: WABA_FIELDS,
      });
      const parsed = wabaSchema.safeParse(raw ?? {});
      if (!parsed.success) return UNKNOWN_WABA;
      return {
        paymentMethodAttached:
          (parsed.data.primary_funding_id ?? '').length > 0,
        accountReviewStatus: parsed.data.account_review_status,
        businessVerificationStatus:
          parsed.data.owner_business_info?.verification_status ?? null,
      };
    } catch {
      // A failed WABA read leaves all three unknown rather than failing the
      // whole health check — and unknown is BLOCKED at the D4 gate.
      return UNKNOWN_WABA;
    }
  }

  private async fetch(
    phoneNumberId: string,
    accessToken: string,
  ): Promise<unknown> {
    try {
      return await this.graph.get(phoneNumberId, accessToken, {
        fields: HEALTH_FIELDS,
      });
    } catch (error) {
      if (
        error instanceof MetaGraphError &&
        error.code === INVALID_FIELD_CODE
      ) {
        return this.graph.get(phoneNumberId, accessToken, {
          fields: HEALTH_FIELDS_WITHOUT_NAME_STATUS,
        });
      }
      throw error;
    }
  }
}

function toIssues(entities: unknown[]): WhatsappHealthIssue[] {
  return entities.flatMap((raw): WhatsappHealthIssue[] => {
    const parsed = entitySchema.safeParse(raw);
    if (!parsed.success) return [];
    const entity = parsed.data;
    if (entity.can_send_message === 'BLOCKED') {
      return (entity.errors ?? []).map((error) => ({
        entityType: entity.entity_type,
        severity: 'BLOCKED' as const,
        errorCode: error.error_code ?? null,
        description: error.error_description,
        possibleSolution: error.possible_solution ?? null,
      }));
    }
    if (entity.can_send_message === 'LIMITED') {
      return (entity.additional_info ?? []).map((info) => ({
        entityType: entity.entity_type,
        severity: 'LIMITED' as const,
        errorCode: null,
        description: info,
        possibleSolution: null,
      }));
    }
    return [];
  });
}
