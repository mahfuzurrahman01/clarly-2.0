// Feature 24 (Store Integrations): OAuth callback endpoint.
// Receives the redirect from Salla/Zid/Shopify and completes the flow.
//
// UNAUTHENTICATED by design (the provider redirects a browser here with no
// bearer token), which is exactly why the tenant is taken ONLY from the
// HMAC-signed `state` — never from a query param, as the first cut did.
// One handler for all providers: three copies of the same flow is three
// places for the next security fix to be applied twice.
import {
  BadRequestException,
  Body,
  Controller,
  Get,
  Param,
  Post,
  Query,
  Res,
} from '@nestjs/common';
import type { Response } from 'express';
import { ApiExcludeController } from '@nestjs/swagger';
import { z } from 'zod';
import { StoreOAuthService } from './store-oauth.service';
import { AppConfigService, AppLoggerService } from '../core';
import { isStoreProviderName } from './store-provider-name';

/**
 * The body WooCommerce's `/wc-auth/v1/authorize` flow POSTs back. Validated
 * rather than trusted: it is an unauthenticated request body, and
 * `consumer_secret` ends up in an encrypted credential column.
 */
const WooCommerceKeyDelivery = z.object({
  /** Our signed state, echoed verbatim — `/wc-auth` has no state param, so this field carries it. */
  user_id: z.string().min(1),
  consumer_key: z.string().min(1).max(512),
  consumer_secret: z.string().min(1).max(512),
  key_id: z.union([z.string(), z.number()]).optional(),
  key_permissions: z.string().optional(),
});

/** Cap on provider-supplied error text copied into a log line (unauthenticated input). */
const MAX_PROVIDER_ERROR_LENGTH = 300;

@ApiExcludeController()
@Controller('store/callback')
export class StoreCallbackController {
  constructor(
    private readonly oauthService: StoreOAuthService,
    private readonly config: AppConfigService,
    private readonly logger: AppLoggerService,
  ) {}

  @Get(':provider')
  async handleCallback(
    @Param('provider') provider: string,
    @Query('code') code: string | undefined,
    @Query('state') state: string | undefined,
    @Query('shop') shop: string | undefined,
    @Query('error') providerError: string | undefined,
    @Query('error_description') providerErrorDescription: string | undefined,
    @Res() res: Response,
    // The whole query, for providers that sign it (Shopify's `hmac` covers
    // every param, including ones this handler never names).
    @Query() query: Record<string, unknown> = {},
  ): Promise<void> {
    if (!isStoreProviderName(provider)) {
      throw new BadRequestException('Unsupported store provider');
    }
    // WooCommerce never redirects here: its site POSTs the credential pair to
    // the handler below. Accepting it on this GET would put a live
    // `consumer_key:consumer_secret` in `?code=`, i.e. in every proxy and
    // access log on the way in — the exact leak the POST route exists to
    // avoid. Reject it outright rather than rely on nobody calling it.
    if (provider === 'woocommerce') {
      throw new BadRequestException('Unsupported store provider');
    }
    // A denied or misconfigured authorization comes back as `?error=` with no
    // code (OAuth 2.0 §4.1.2.1). The merchant's browser is on this URL, so
    // send them back to the console, not to a bare 400. No tenant id in the
    // log: the state is unverified here.
    if (!code && providerError) {
      this.logger.warn(
        `${provider} OAuth authorization returned an error: ${providerError.slice(0, MAX_PROVIDER_ERROR_LENGTH)}` +
          (providerErrorDescription
            ? ` (${providerErrorDescription.slice(0, MAX_PROVIDER_ERROR_LENGTH)})`
            : ''),
        'StoreCallbackController',
      );
      res.redirect(`${this.consoleBaseUrl}/stores?error=oauth_failed`);
      return;
    }
    if (!code) {
      throw new BadRequestException('Missing required query parameter: code');
    }

    try {
      const result = await this.oauthService.handleCallback(
        provider,
        code,
        state,
        { shop },
        query,
      );
      this.logger.log(
        `${provider} OAuth completed for tenant ${result.tenantId}: ${result.storeName}`,
        'StoreCallbackController',
      );
      // The store is connected even when its webhooks could not be
      // subscribed; `webhooks=failed` tells the console so instead of the
      // merchant finding out from missing order/product updates.
      const webhooks = result.webhooksRegistered ? '' : '&webhooks=failed';
      res.redirect(
        `${this.consoleBaseUrl}/stores?connected=true&store=${encodeURIComponent(result.storeName)}${webhooks}`,
      );
    } catch (err) {
      // Deliberately no tenant id in this log line: on a rejected state we do
      // not have one, and on a forged state anything we could print came from
      // the attacker.
      this.logger.error(
        `${provider} OAuth callback failed: ${err instanceof Error ? err.message : String(err)}`,
        'StoreCallbackController',
      );
      res.redirect(`${this.consoleBaseUrl}/stores?error=oauth_failed`);
    }
  }

  /**
   * WooCommerce's key delivery. Unlike the three OAuth providers, WooCommerce
   * does not redirect a browser back with a code — the merchant's own site
   * makes a server-to-server POST carrying the permanent credential pair, and
   * echoes our signed state back in `user_id` (`/wc-auth/v1/authorize` has no
   * `state` parameter of its own).
   *
   * Unauthenticated for the same reason the GET above is, and safe for the
   * same reason: the tenant AND the merchant's site both come only from the
   * HMAC-signed state. Nothing in this body chooses either. A forged or
   * expired state writes nothing and returns 400.
   */
  @Post('woocommerce')
  async handleWooCommerceKeyDelivery(
    @Body() body: unknown,
  ): Promise<{ success: true }> {
    const payload = WooCommerceKeyDelivery.safeParse(body);
    if (!payload.success) {
      throw new BadRequestException('Malformed WooCommerce key delivery');
    }
    const { user_id: state, consumer_key, consumer_secret } = payload.data;

    try {
      const result = await this.oauthService.handleCallback(
        'woocommerce',
        `${consumer_key}:${consumer_secret}`,
        state,
        undefined,
      );
      this.logger.log(
        `woocommerce key delivery completed for tenant ${result.tenantId}: ${result.storeName}`,
        'StoreCallbackController',
      );
      // WooCommerce expects a 2xx and ignores the body; the merchant's browser
      // is separately on `return_url`, so there is nothing to redirect here.
      return { success: true };
    } catch (err) {
      // No tenant id in this line, same reasoning as the GET handler: on a
      // rejected state we do not have one.
      this.logger.error(
        `woocommerce key delivery failed: ${err instanceof Error ? err.message : String(err)}`,
        'StoreCallbackController',
      );
      throw new BadRequestException(
        'WooCommerce connection could not be completed',
      );
    }
  }

  private get consoleBaseUrl(): string {
    return this.config.consoleBaseUrl || 'http://localhost:3000';
  }
}
