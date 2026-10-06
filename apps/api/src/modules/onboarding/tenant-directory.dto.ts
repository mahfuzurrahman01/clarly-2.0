import { createZodDto } from 'nestjs-zod';
import { z } from 'zod';
import {
  TENANT_LOCALES,
  TENANT_VERTICALS,
} from '../persistence/drizzle/schema';

export const tenantDirectoryEntrySchema = z.object({
  id: z.string().uuid().describe('The calling user’s own tenant id.'),
  name: z
    .string()
    .describe('Workspace name, for display. Not unique across the platform.'),
  vertical: z
    .enum(TENANT_VERTICALS)
    .describe(
      'v2: what kind of business this is. `commerce` sells products, `services` books appointments, `hybrid` does both. Decides onboarding defaults and console emphasis; never hides a feature the tenant has paid for.',
    ),
  country: z
    .string()
    .nullable()
    .describe('v2: ISO 3166-1 alpha-2, or null when not set yet.'),
  currency: z
    .string()
    .nullable()
    .describe(
      'v2: ISO 4217 code used for prices and reports, or null when not set yet.',
    ),
  defaultLocale: z
    .enum(TENANT_LOCALES)
    .describe('v2: the console language new team members start in.'),
});

export type TenantDirectoryEntry = z.infer<typeof tenantDirectoryEntrySchema>;

export class TenantDirectoryEntryDto extends createZodDto(
  tenantDirectoryEntrySchema,
) {}

/**
 * v2 S1: PATCH /onboarding/tenant/profile. Every field optional; omitted keeps
 * its value. `country` / `currency` accept null to clear. Codes are
 * upper-cased before validation so `sa` / `sar` are accepted as typed.
 */
export const updateTenantProfileBodySchema = z
  .object({
    name: z.string().trim().min(1).max(120).optional(),
    vertical: z.enum(TENANT_VERTICALS).optional(),
    country: z
      .preprocess(
        (v) => (typeof v === 'string' ? v.trim().toUpperCase() : v),
        z
          .string()
          .regex(/^[A-Z]{2}$/, 'ISO 3166-1 alpha-2, e.g. SA')
          .nullable(),
      )
      .optional(),
    currency: z
      .preprocess(
        (v) => (typeof v === 'string' ? v.trim().toUpperCase() : v),
        z
          .string()
          .regex(/^[A-Z]{3}$/, 'ISO 4217, e.g. SAR')
          .nullable(),
      )
      .optional(),
    defaultLocale: z.enum(TENANT_LOCALES).optional(),
  })
  .strict()
  .refine((body) => Object.keys(body).length > 0, {
    message: 'Send at least one field to change.',
  });

export type UpdateTenantProfileBody = z.infer<
  typeof updateTenantProfileBodySchema
>;

export class UpdateTenantProfileBodyDto extends createZodDto(
  updateTenantProfileBodySchema,
) {}
