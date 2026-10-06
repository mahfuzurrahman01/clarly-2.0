// Response contracts for BillingController. Defined as Zod schemas with the
// exported types inferred from them, so the OpenAPI models and the compile-
// time types come from one declaration rather than a hand-kept pair that can
// drift (CLAUDE.md's DRY principle).
import { createZodDto } from 'nestjs-zod';
import { z } from 'zod';
import { isoTimestamp } from '../../common/iso-timestamp';
import { SUBSCRIPTION_STATUSES } from '../persistence/drizzle/tenant-subscriptions.table';

export const planRecordSchema = z.object({
  id: z.string().uuid(),
  name: z.string(),
  stripePriceId: z.string(),
  monthlyMessageLimit: z.number().int(),
  monthlySpendCapUsd: z.number(),
  trialDays: z.number().int(),
});

/**
 * Launch billing backend (Lane A, frontend contract request): the
 * public-safe projection of `planRecordSchema` — no `stripePriceId` (an
 * internal identifier, not something a signed-out visitor on /pricing
 * needs or should see). Serves GET /billing/plans/public, the one
 * unauthenticated billing read in this app, alongside the existing
 * admin-only GET /billing/plans (which still returns the full record,
 * `stripePriceId` included, for the in-app checkout flow).
 */
export const publicPlanRecordSchema = planRecordSchema.omit({
  stripePriceId: true,
});

export type PublicPlanRecord = z.infer<typeof publicPlanRecordSchema>;
export class PublicPlanListDto extends createZodDto(
  z.array(publicPlanRecordSchema),
) {}

export const tenantSubscriptionRecordSchema = z.object({
  id: z.string().uuid(),
  tenantId: z.string().uuid(),
  planId: z.string().uuid(),
  stripeCustomerId: z
    .string()
    .nullable()
    .describe(
      'Null for a tenant on a LOCAL trial row (signup, no Stripe interaction yet) or a comped tenant who has never started Checkout.',
    ),
  stripeSubscriptionId: z.string().nullable(),
  status: z.enum(SUBSCRIPTION_STATUSES),
  trialEndsAt: isoTimestamp().nullable(),
  currentPeriodEnd: isoTimestamp().nullable(),
  cancelAtPeriodEnd: z
    .boolean()
    .describe(
      'True when the tenant has cancelled but the period they already paid for is still running. `status` stays `active` throughout — Stripe keeps it active until the moment it ends — so this is the only field that tells a tenant they are leaving.',
    ),
  comped: z
    .boolean()
    .describe(
      'True when a platform operator (scripts/comp-tenant.ts) has manually granted this tenant entitlement, independent of status/trialEndsAt. Never set through this API.',
    ),
});

export const billingPortalSessionSchema = z.object({
  portalUrl: z
    .string()
    .url()
    .describe(
      'Stripe-hosted billing portal — redirect the browser here. Covers changing a card, downloading invoices, and cancelling.',
    ),
});

export type BillingPortalSession = z.infer<typeof billingPortalSessionSchema>;

export const startSubscriptionResultSchema = z.object({
  checkoutUrl: z
    .string()
    .url()
    .describe('Stripe-hosted checkout page — redirect the browser here.'),
});

export type PlanRecord = z.infer<typeof planRecordSchema>;
export type TenantSubscriptionRecord = z.infer<
  typeof tenantSubscriptionRecordSchema
>;
export type StartSubscriptionResult = z.infer<
  typeof startSubscriptionResultSchema
>;

export class PlanRecordDto extends createZodDto(planRecordSchema) {}
export class PlanListDto extends createZodDto(z.array(planRecordSchema)) {}
export class TenantSubscriptionRecordDto extends createZodDto(
  tenantSubscriptionRecordSchema,
) {}
export class StartSubscriptionResultDto extends createZodDto(
  startSubscriptionResultSchema,
) {}
export class BillingPortalSessionDto extends createZodDto(
  billingPortalSessionSchema,
) {}
