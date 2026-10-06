import { BadRequestException } from '@nestjs/common';
import type { Response } from 'express';
import type { AppConfigService, AppLoggerService } from '../core';
import { StoreCallbackController } from './store-callback.controller';
import type { StoreOAuthService } from './store-oauth.service';

function makeController() {
  const handleCallback = jest.fn();
  const warn = jest.fn();
  const redirect = jest.fn();
  const oauthService = { handleCallback } as unknown as StoreOAuthService;
  const logger = {
    log: jest.fn(),
    error: jest.fn(),
    warn,
  } as unknown as AppLoggerService;
  const config = {
    consoleBaseUrl: 'https://app.example.com',
  } as unknown as AppConfigService;
  const controller = new StoreCallbackController(oauthService, config, logger);
  const res = { redirect } as unknown as Response;
  return { controller, handleCallback, warn, redirect, res };
}

describe('StoreCallbackController — GET callback', () => {
  it('redirects a provider ?error= callback to the console instead of a bare 400', async () => {
    const { controller, handleCallback, warn, redirect, res } =
      makeController();

    await controller.handleCallback(
      'salla',
      undefined,
      'signed-state',
      undefined,
      'invalid_scope',
      'The OAuth 2.0 Client is not allowed to request scope',
      res,
    );

    expect(redirect).toHaveBeenCalledWith(
      'https://app.example.com/stores?error=oauth_failed',
    );
    expect(handleCallback).not.toHaveBeenCalled();
    expect(warn).toHaveBeenCalledWith(
      expect.stringContaining('invalid_scope'),
      'StoreCallbackController',
    );
  });

  it('still rejects a callback with neither code nor error', async () => {
    const { controller, res } = makeController();
    await expect(
      controller.handleCallback(
        'salla',
        undefined,
        'signed-state',
        undefined,
        undefined,
        undefined,
        res,
      ),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it('completes the flow and redirects on a code', async () => {
    const { controller, handleCallback, redirect, res } = makeController();
    handleCallback.mockResolvedValue({
      tenantId: 't-1',
      storeName: 'Abaya House',
      webhooksRegistered: true,
    });

    await controller.handleCallback(
      'salla',
      'the-code',
      'signed-state',
      undefined,
      undefined,
      undefined,
      res,
    );

    expect(redirect).toHaveBeenCalledWith(
      'https://app.example.com/stores?connected=true&store=Abaya%20House',
    );
  });

  it('still reports the connect, flagged, when webhook subscription failed', async () => {
    const { controller, handleCallback, redirect, res } = makeController();
    handleCallback.mockResolvedValue({
      tenantId: 't-1',
      storeName: 'Zid Store',
      webhooksRegistered: false,
    });

    await controller.handleCallback(
      'zid',
      'the-code',
      'signed-state',
      undefined,
      undefined,
      undefined,
      res,
    );

    expect(redirect).toHaveBeenCalledWith(
      'https://app.example.com/stores?connected=true&store=Zid%20Store&webhooks=failed',
    );
  });

  it('passes the whole query through, so a provider signature covers every param', async () => {
    const { controller, handleCallback, res } = makeController();
    handleCallback.mockResolvedValue({
      tenantId: 't-1',
      storeName: 'shop',
      webhooksRegistered: true,
    });
    const query = {
      code: 'the-code',
      state: 'signed-state',
      shop: 'acme.myshopify.com',
      hmac: 'abc',
      host: 'YWRtaW4',
      timestamp: '1337178173',
    };

    await controller.handleCallback(
      'shopify',
      'the-code',
      'signed-state',
      'acme.myshopify.com',
      undefined,
      undefined,
      res,
      query,
    );

    expect(handleCallback).toHaveBeenCalledWith(
      'shopify',
      'the-code',
      'signed-state',
      { shop: 'acme.myshopify.com' },
      query,
    );
  });

  it('redirects a rejected callback (bad hmac) to oauth_failed like any other failure', async () => {
    const { controller, handleCallback, redirect, res } = makeController();
    handleCallback.mockRejectedValue(
      new Error('shopify callback signature is invalid.'),
    );

    await controller.handleCallback(
      'shopify',
      'the-code',
      'signed-state',
      'acme.myshopify.com',
      undefined,
      undefined,
      res,
      { code: 'the-code', hmac: 'forged' },
    );

    expect(redirect).toHaveBeenCalledWith(
      'https://app.example.com/stores?error=oauth_failed',
    );
  });
});
