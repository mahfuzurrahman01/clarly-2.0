// F19 (Open Question 2): the merchant-facing marketing-only opt-out toggle.
import { NotFoundException } from '@nestjs/common';
import type { TenantAuthContext } from '../auth/jwt-claims';
import { CustomerMarketingConsentController } from './customer-marketing-consent.controller';
import type {
  CustomerConsent,
  CustomerConsentService,
} from './customer-consent.service';
import type { CustomerService } from './customer.service';

const TENANT_A = '00000000-0000-0000-0000-00000000000a';
const CUSTOMER_ID = '11111111-1111-1111-1111-111111111111';

const auth = {
  tenantId: TENANT_A,
  userId: '22222222-2222-2222-2222-222222222222',
  appRole: 'admin',
} as TenantAuthContext;

const noopAudit = { describe: jest.fn() };

function makeConsent(
  overrides: Partial<CustomerConsent> = {},
): CustomerConsent {
  return {
    customerId: CUSTOMER_ID,
    channel: 'whatsapp',
    phone: '+15551234567',
    optedOutAt: null,
    optOutSource: null,
    marketingOptedOutAt: null,
    ...overrides,
  };
}

function makeHarness(customerExists = true) {
  const setMarketingOptOut = jest
    .fn()
    .mockResolvedValue(
      makeConsent({ marketingOptedOutAt: new Date('2026-01-01T00:00:00Z') }),
    );
  const getCustomer = jest
    .fn()
    .mockResolvedValue(customerExists ? { id: CUSTOMER_ID } : null);

  const controller = new CustomerMarketingConsentController(
    { setMarketingOptOut } as unknown as CustomerConsentService,
    { getCustomer } as unknown as CustomerService,
  );

  return { controller, setMarketingOptOut, getCustomer };
}

describe('CustomerMarketingConsentController', () => {
  it('sets the marketing opt-out for a customer in the calling tenant', async () => {
    const { controller, setMarketingOptOut } = makeHarness();

    await expect(
      controller.set(auth, CUSTOMER_ID, { optedOut: true }, noopAudit),
    ).resolves.toMatchObject({ marketingOptedOutAt: expect.any(Date) });

    expect(setMarketingOptOut).toHaveBeenCalledWith(
      TENANT_A,
      CUSTOMER_ID,
      true,
    );
  });

  it('404s when the customer does not exist in this tenant', async () => {
    const { controller } = makeHarness(false);

    await expect(
      controller.set(auth, CUSTOMER_ID, { optedOut: true }, noopAudit),
    ).rejects.toThrow(NotFoundException);
  });

  it('404s when the service reports the row is gone despite the pre-check', async () => {
    const { controller, setMarketingOptOut } = makeHarness();
    setMarketingOptOut.mockResolvedValueOnce(null);

    await expect(
      controller.set(auth, CUSTOMER_ID, { optedOut: true }, noopAudit),
    ).rejects.toThrow(NotFoundException);
  });
});
