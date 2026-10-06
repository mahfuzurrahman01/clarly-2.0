// Feature 24 (Store Integrations): webhook receiver.
//
// NOT behind TenantAuthMiddleware — a store has no tenant JWT to send. Trust
// comes from the per-provider signature that StoreWebhookService verifies, and
// the tenant is resolved from (provider, store_id). Needs `req.rawBody`
// (enabled app-wide in main.ts for the Stripe webhook) because a signature is
// over the exact bytes, not over a re-serialized object.
import {
  BadRequestException,
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
import { StoreWebhookService } from './store-webhook.service';
import { AppLoggerService } from '../core';
import { isStoreProviderName } from './store-provider-name';

@ApiExcludeController()
@Controller('store/webhook')
export class StoreWebhookController {
  constructor(
    private readonly webhookService: StoreWebhookService,
    private readonly logger: AppLoggerService,
  ) {}

  @Post(':provider/:storeId')
  @HttpCode(HttpStatus.OK)
  async handleWebhook(
    @Param('provider') provider: string,
    @Param('storeId') storeId: string,
    @Req() req: RawBodyRequest<Request>,
  ): Promise<{ received: boolean; duplicate?: boolean }> {
    if (!isStoreProviderName(provider)) {
      throw new BadRequestException('Unsupported store provider');
    }

    // Header names arrive lowercased from Node; pass them through as-is so the
    // adapter can look up its own provider-specific header.
    const headers = req.headers as Record<string, string | undefined>;
    const outcome = await this.webhookService.handleWebhook(
      provider,
      storeId,
      req.rawBody,
      headers,
    );

    this.logger.debug(
      `Store webhook ${provider}/${storeId}: processed=${outcome.processed} duplicate=${outcome.duplicate ?? false}`,
      'StoreWebhookController',
    );
    return { received: true, duplicate: outcome.duplicate };
  }
}
