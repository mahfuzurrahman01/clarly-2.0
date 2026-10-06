import { createZodDto } from 'nestjs-zod';
import { z } from 'zod';

export const startCheckoutBodySchema = z.object({
  planId: z.string().uuid().describe('A plan id from `GET /billing/plans`.'),
  email: z
    .string()
    .email()
    .describe('Billing contact — becomes the Stripe customer email.'),
  successUrl: z
    .string()
    .url()
    .describe('Absolute URL Stripe redirects to after a completed checkout.'),
  cancelUrl: z
    .string()
    .url()
    .describe('Absolute URL Stripe redirects to if the customer backs out.'),
});

export type StartCheckoutBody = z.infer<typeof startCheckoutBodySchema>;

/** Swagger-visible mirror of the schema above — same object, exposed as a class so `@nestjs/swagger` can reflect it into the OpenAPI document. */
export class StartCheckoutBodyDto extends createZodDto(
  startCheckoutBodySchema,
) {}

export const billingPortalBodySchema = z.object({
  returnUrl: z
    .string()
    .url()
    .describe(
      'Absolute URL Stripe returns the tenant to when they close the portal.',
    ),
});

export type BillingPortalBody = z.infer<typeof billingPortalBodySchema>;
export class BillingPortalBodyDto extends createZodDto(
  billingPortalBodySchema,
) {}

export const cancelSubscriptionBodySchema = z.object({
  atPeriodEnd: z
    .boolean()
    .default(true)
    .describe(
      'Default true: keep the subscription running until the period already paid for runs out. False ends it immediately and forfeits the remainder — a refund decision, so it has to be asked for explicitly.',
    ),
});

export type CancelSubscriptionBody = z.infer<
  typeof cancelSubscriptionBodySchema
>;
export class CancelSubscriptionBodyDto extends createZodDto(
  cancelSubscriptionBodySchema,
) {}
