import { BadRequestException } from '@nestjs/common';
import type { RawBodyRequest } from '@nestjs/common';
import type { Request } from 'express';
import { BillingWebhookController } from './billing-webhook.controller';
import type { BillingService } from './billing.service';

function makeController(): {
  controller: BillingWebhookController;
  billing: { handleWebhookEvent: jest.Mock };
} {
  const billing = {
    handleWebhookEvent: jest.fn().mockResolvedValue(undefined),
  };
  const controller = new BillingWebhookController(
    billing as unknown as BillingService,
  );
  return { controller, billing };
}

describe('BillingWebhookController', () => {
  it('verifies and forwards the raw body + signature to BillingService', async () => {
    const { controller, billing } = makeController();
    const rawBody = Buffer.from('{"id":"evt_1"}');
    const req = { rawBody } as RawBodyRequest<Request>;

    const result = await controller.handle(req, 'sig_abc');

    expect(result).toEqual({ received: true });
    expect(billing.handleWebhookEvent).toHaveBeenCalledWith(rawBody, 'sig_abc');
  });

  it('rejects a request with no raw body', async () => {
    const { controller } = makeController();
    const req = {} as RawBodyRequest<Request>;

    await expect(controller.handle(req, 'sig_abc')).rejects.toBeInstanceOf(
      BadRequestException,
    );
  });

  it('rejects a request with no stripe-signature header', async () => {
    const { controller } = makeController();
    const req = { rawBody: Buffer.from('{}') } as RawBodyRequest<Request>;

    await expect(controller.handle(req, undefined)).rejects.toBeInstanceOf(
      BadRequestException,
    );
  });
});
