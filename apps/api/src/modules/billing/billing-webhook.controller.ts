// Product shell (BillingModule, Feature 8/T19): the one endpoint in this
// app that Stripe itself calls directly — deliberately NOT behind
// TenantAuthMiddleware/RolesGuard (Stripe has no tenant JWT to send).
// Trust comes entirely from the webhook signature (verified inside
// `BillingService.handleWebhookEvent()` -> `BillingProvider.
// constructWebhookEvent()`), the same "a different, narrower trust
// boundary than every other route" pattern `SignupController`/
// `FreshSignupAuthGuard` already established for the one other
// no-tenant-yet endpoint in this app.
import {
  BadRequestException,
  Controller,
  Headers,
  Post,
  Req,
} from '@nestjs/common';
import type { RawBodyRequest } from '@nestjs/common';
import { ApiExcludeController } from '@nestjs/swagger';
import type { Request } from 'express';
import { BillingService } from './billing.service';

@ApiExcludeController()
@Controller('billing/webhook')
export class BillingWebhookController {
  constructor(private readonly billing: BillingService) {}

  @Post()
  async handle(
    @Req() req: RawBodyRequest<Request>,
    @Headers('stripe-signature') signature: string | undefined,
  ): Promise<{ received: true }> {
    if (!req.rawBody) {
      // Only reachable if `rawBody: true` was somehow not applied to this
      // request (main.ts sets it app-wide) — fail loudly rather than
      // silently accepting an unverifiable payload.
      throw new BadRequestException('Missing raw request body');
    }
    if (!signature) {
      throw new BadRequestException('Missing stripe-signature header');
    }

    await this.billing.handleWebhookEvent(req.rawBody, signature);
    return { received: true };
  }
}
