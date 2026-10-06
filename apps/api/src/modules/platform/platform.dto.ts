import { createZodDto } from 'nestjs-zod';
import { z } from 'zod';
import { isoTimestamp } from '../../common/iso-timestamp';
import {
  PLATFORM_ROLES,
  TENANT_LOCALES,
  TENANT_VERTICALS,
} from '../persistence/drizzle/schema';

export const platformMeSchema = z.object({
  userId: z.string().uuid(),
  email: z.string(),
  role: z.enum(PLATFORM_ROLES),
});
export class PlatformMeDto extends createZodDto(platformMeSchema) {}

const subscriptionSchema = z
  .object({
    status: z
      .string()
      .describe('Stripe-mirrored status, or `trialing` for a local trial.'),
    planName: z.string(),
    trialEndsAt: isoTimestamp().nullable(),
    currentPeriodEnd: isoTimestamp().nullable(),
    cancelAtPeriodEnd: z.boolean(),
    comped: z
      .boolean()
      .describe('Operator override: entitled regardless of billing status.'),
  })
  .nullable()
  .describe(
    'Null when the tenant has no subscription row (blocked by the entitlement gate).',
  );

const usageSchema = z
  .object({
    turns30d: z.number().int(),
    costUsd30d: z.number(),
  })
  .nullable()
  .describe(
    'Null when usage could not be read this time; the tenant is still listed.',
  );

export const platformTenantSummarySchema = z.object({
  id: z.string().uuid(),
  name: z.string(),
  vertical: z.enum(TENANT_VERTICALS),
  country: z.string().nullable(),
  currency: z.string().nullable(),
  defaultLocale: z.enum(TENANT_LOCALES),
  createdAt: isoTimestamp(),
  closedAt: isoTimestamp().nullable(),
  subscription: subscriptionSchema,
  usage: usageSchema,
});
export class PlatformTenantSummaryDto extends createZodDto(
  platformTenantSummarySchema,
) {}

export const platformTenantPageSchema = z.object({
  items: z.array(platformTenantSummarySchema),
  nextCursor: z
    .string()
    .nullable()
    .describe(
      'Opaque keyset cursor; pass it back as `cursor`. Null on the last page.',
    ),
});
export class PlatformTenantPageDto extends createZodDto(
  platformTenantPageSchema,
) {}

export const listPlatformTenantsQuerySchema = z.object({
  search: z
    .string()
    .trim()
    .max(120)
    .optional()
    .describe(
      'Case-insensitive match on the workspace name, or an exact tenant id.',
    ),
  limit: z.coerce.number().int().min(1).max(50).default(25),
  cursor: z.string().max(200).optional(),
});
export type ListPlatformTenantsQuery = z.infer<
  typeof listPlatformTenantsQuerySchema
>;
export class ListPlatformTenantsQueryDto extends createZodDto(
  listPlatformTenantsQuerySchema,
) {}
