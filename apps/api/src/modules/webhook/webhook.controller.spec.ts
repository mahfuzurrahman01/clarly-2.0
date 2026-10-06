import {
  BadRequestException,
  ForbiddenException,
  NotFoundException,
  UnauthorizedException,
  type RawBodyRequest,
} from '@nestjs/common';
import type { Request } from 'express';
import type { WhatsappChannelAdapter } from '../channel/whatsapp-channel.adapter';
import type { WabaHealthWebhookService } from '../whatsapp/whatsapp.module';
import { UnknownChannelAccountError } from './channel-tenant-resolver.service';
import { WebhookController } from './webhook.controller';
import {
  WebhookIngestService,
  WebhookSignatureVerificationError,
} from './webhook-ingest.service';

describe('WebhookController', () => {
  const ingest = jest.fn();
  const service = { ingest } as unknown as WebhookIngestService;
  const verifySubscription = jest.fn();
  const channelAdapter = {
    verifySubscription,
  } as unknown as WhatsappChannelAdapter;
  const applyHealth = jest.fn();
  const wabaHealth = {
    apply: applyHealth,
  } as unknown as WabaHealthWebhookService;
  const controller = new WebhookController(service, channelAdapter, wabaHealth);

  const rawBody = Buffer.from('{"entry":[]}');
  const req = {
    rawBody,
    headers: { 'x-hub-signature-256': 'sig' },
  } as unknown as RawBodyRequest<Request>;

  beforeEach(() => {
    ingest.mockReset().mockResolvedValue([]);
    applyHealth.mockReset().mockResolvedValue(undefined);
  });

  describe('WABA health fields (Gulf T5)', () => {
    it('applies account/quality/name updates from the same body after ingest verified it', async () => {
      const order: string[] = [];
      ingest.mockImplementation(() => {
        order.push('ingest');
        return Promise.resolve([]);
      });
      applyHealth.mockImplementation(() => {
        order.push('health');
        return Promise.resolve();
      });

      await expect(controller.handle(req)).resolves.toEqual({ received: true });

      expect(applyHealth).toHaveBeenCalledWith(rawBody);
      expect(order).toEqual(['ingest', 'health']);
    });

    it('never applies health updates from a body whose signature failed', async () => {
      ingest.mockRejectedValue(new WebhookSignatureVerificationError());
      await expect(controller.handle(req)).rejects.toBeInstanceOf(
        UnauthorizedException,
      );
      expect(applyHealth).not.toHaveBeenCalled();
    });

    it('lets a failed health write propagate as a 500 so Meta redelivers', async () => {
      applyHealth.mockRejectedValue(new Error('db down'));
      await expect(controller.handle(req)).rejects.toThrow('db down');
    });
  });

  it('passes the raw bytes and headers to the ingest pipeline with the bound adapter', async () => {
    await expect(controller.handle(req)).resolves.toEqual({ received: true });

    expect(ingest).toHaveBeenCalledWith(channelAdapter, rawBody, {
      'x-hub-signature-256': 'sig',
    });
  });

  it('ACKs 200 regardless of per-message outcome (T11: duplicates and rate-limits are not delivery failures)', async () => {
    ingest.mockResolvedValue([
      { bspMessageId: 'w1', outcome: 'duplicate' },
      { bspMessageId: 'w2', outcome: 'rate_limited' },
    ]);

    await expect(controller.handle(req)).resolves.toEqual({ received: true });
  });

  it('does not echo per-message outcomes back to the BSP', async () => {
    ingest.mockResolvedValue([{ bspMessageId: 'w1', outcome: 'enqueued' }]);

    const response = await controller.handle(req);

    expect(Object.keys(response)).toEqual(['received']);
  });

  it('maps a failed signature to 401, never 200', async () => {
    ingest.mockRejectedValue(new WebhookSignatureVerificationError());

    await expect(controller.handle(req)).rejects.toBeInstanceOf(
      UnauthorizedException,
    );
  });

  it('maps an unrecognized phone_number_id to 404', async () => {
    ingest.mockRejectedValue(
      new UnknownChannelAccountError('whatsapp', 'pn-1'),
    );

    await expect(controller.handle(req)).rejects.toBeInstanceOf(
      NotFoundException,
    );
  });

  it('lets an unexpected internal failure propagate as a 500 so the BSP retries', async () => {
    ingest.mockRejectedValue(new Error('redis is down'));

    await expect(controller.handle(req)).rejects.toThrow('redis is down');
  });

  it('rejects when the raw body is unavailable — nothing could be verified', async () => {
    await expect(
      controller.handle({ headers: {} } as RawBodyRequest<Request>),
    ).rejects.toBeInstanceOf(BadRequestException);
    expect(ingest).not.toHaveBeenCalled();
  });

  describe('GET subscription handshake', () => {
    it('echoes the challenge the adapter returns', () => {
      verifySubscription.mockReturnValue('1158201444');

      expect(
        controller.handleSubscription({
          'hub.mode': 'subscribe',
          'hub.verify_token': 'tok',
          'hub.challenge': '1158201444',
        }),
      ).toBe('1158201444');
    });

    it('passes the raw query straight to the bound adapter', () => {
      verifySubscription.mockReturnValue('x');
      const query = { 'hub.mode': 'subscribe', 'hub.challenge': 'x' };

      controller.handleSubscription(query);

      expect(verifySubscription).toHaveBeenCalledWith(query);
    });

    it('403s when the adapter rejects (wrong token, or a non-Meta binding)', () => {
      verifySubscription.mockReturnValue(null);

      expect(() => controller.handleSubscription({})).toThrow(
        ForbiddenException,
      );
    });
  });
});
