import { createZodDto } from 'nestjs-zod';
import { z } from 'zod';
import { isoTimestamp } from '../../common/iso-timestamp';
import { OPT_OUT_SOURCES } from '../persistence/drizzle/schema';

export const customerConsentSchema = z.object({
  customerId: z.string().uuid(),
  phone: z.string(),
  optedOutAt: isoTimestamp()
    .nullable()
    .describe(
      'When this customer asked to stop hearing from us. Null means they have not — business-initiated messaging is allowed.',
    ),
  optOutSource: z
    .enum(OPT_OUT_SOURCES)
    .nullable()
    .describe(
      '`customer_keyword` they typed STOP; `admin` someone recorded it on their behalf. A compliance question is never just "did they", it is "how do you know".',
    ),
  marketingOptedOutAt: isoTimestamp()
    .nullable()
    .describe(
      'F19: the narrower, marketing-only opt-out. Null means campaign sends are allowed (subject to `optedOutAt` also being null — a global opt-out blocks everything regardless of this value).',
    ),
});

export type CustomerConsentRecord = z.infer<typeof customerConsentSchema>;
export class CustomerConsentDto extends createZodDto(customerConsentSchema) {}

export const setConsentBodySchema = z.object({
  phone: z
    .string()
    .min(1)
    .describe(
      'The customer phone number, in the same form the BSP reports it.',
    ),
  optedOut: z
    .boolean()
    .describe(
      'True to stop business-initiated messaging to this number, false to allow it again.',
    ),
});

export type SetConsentBody = z.infer<typeof setConsentBodySchema>;
export class SetConsentBodyDto extends createZodDto(setConsentBodySchema) {}

export const setMarketingConsentBodySchema = z.object({
  optedOut: z
    .boolean()
    .describe(
      'True to stop campaign sends to this customer, false to allow them again. Independent of the global opt-out.',
    ),
});

export type SetMarketingConsentBody = z.infer<
  typeof setMarketingConsentBodySchema
>;
export class SetMarketingConsentBodyDto extends createZodDto(
  setMarketingConsentBodySchema,
) {}
