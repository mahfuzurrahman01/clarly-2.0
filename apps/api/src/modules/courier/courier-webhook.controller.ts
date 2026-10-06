// F26 (Delivery Tracking): the courier push receiver (D6).
//
// NOT behind TenantAuthMiddleware — a courier has no tenant JWT. Trust comes
// entirely from the per-connection digest `CourierWebhookService` verifies,
// and the tenant is resolved from (courier, account_ref) in the URL. Needs
// `req.rawBody` (enabled app-wide in main.ts for the Stripe webhook) because
// a digest is over the exact bytes, not over a re-serialized object.
//
// The route exists only for couriers whose signature scheme we can actually
// verify; the service rejects the rest at step 1, so J&T is the only courier
// this path currently accepts.
import {
  Controller,
  HttpCode,
  HttpStatus,
  Param,
  Post,
  Req,
} from '@nestjs/common';
import type { RawBodyRequest } from '@nestjs/common';
import type { Request } from 'express';
import { ApiExcludeController } from '@nestjs/swagger';
import {
  CourierWebhookService,
  type CourierWebhookOutcome,
} from './courier-webhook.service';

@ApiExcludeController()
@Controller('couriers/webhook')
export class CourierWebhookController {
  constructor(private readonly webhookService: CourierWebhookService) {}

  @Post(':courier/:accountRef')
  @HttpCode(HttpStatus.OK)
  async handleWebhook(
    @Param('courier') courier: string,
    @Param('accountRef') accountRef: string,
    @Req() req: RawBodyRequest<Request>,
  ): Promise<CourierWebhookOutcome> {
    // Header names arrive lowercased from Node; passed through as-is so the
    // adapter can look up its OWN header name rather than one we invented.
    const headers = req.headers as Record<string, string | undefined>;
    return this.webhookService.handleWebhook(
      courier,
      accountRef,
      req.rawBody,
      headers,
    );
  }
}
