import type { AppLoggerService } from '../../core';
import { NoopBillingProvider } from './noop-billing.provider';

describe('NoopBillingProvider', () => {
  it('fabricates a customer id and logs what it would have done', async () => {
    const warn = jest.fn();
    const provider = new NoopBillingProvider({
      warn,
    } as unknown as AppLoggerService);

    const customerId = await provider.createCustomer('a@b.com');

    expect(customerId).toEqual(expect.stringContaining('noop_cus_'));
    expect(warn).toHaveBeenCalledWith(
      expect.stringContaining('a@b.com'),
      'NoopBillingProvider',
    );
  });

  it('returns the cancelUrl as a stand-in checkout URL and logs what it would have done', async () => {
    const warn = jest.fn();
    const provider = new NoopBillingProvider({
      warn,
    } as unknown as AppLoggerService);

    const url = await provider.createCheckoutSession({
      stripeCustomerId: 'cus_1',
      stripePriceId: 'price_1',
      successUrl: 'https://s',
      cancelUrl: 'https://c',
    });

    expect(url).toBe('https://c');
    expect(warn).toHaveBeenCalledWith(
      expect.stringContaining('cus_1'),
      'NoopBillingProvider',
    );
  });

  it('always returns an ignored event and logs loudly (a webhook call should never reach here)', () => {
    const warn = jest.fn();
    const provider = new NoopBillingProvider({
      warn,
    } as unknown as AppLoggerService);

    const event = provider.constructWebhookEvent();

    expect(event.type).toBe('ignored');
    expect(warn).toHaveBeenCalledWith(
      expect.stringContaining('BILLING_PROVIDER=none'),
      'NoopBillingProvider',
    );
  });
});
