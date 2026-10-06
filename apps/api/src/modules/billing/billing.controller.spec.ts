import type { TenantAuthContext } from '../auth/jwt-claims';
import { BillingController } from './billing.controller';
import type { BillingService } from './billing.service';
import type { UsageService } from './usage.service';

const AUTH: TenantAuthContext = {
  userId: 'admin-1',
  tenantId: 'tenant-a',
  role: 'authenticated',
  appRole: 'admin',
};

function makeController(): {
  controller: BillingController;
  billing: {
    listPlans: jest.Mock;
    getForTenant: jest.Mock;
    startSubscription: jest.Mock;
    createPortalSession: jest.Mock;
    cancelSubscription: jest.Mock;
  };
  usage: { getMonthlyUsage: jest.Mock };
} {
  const billing = {
    listPlans: jest.fn(),
    getForTenant: jest.fn(),
    startSubscription: jest.fn(),
    createPortalSession: jest.fn(),
    cancelSubscription: jest.fn(),
  };
  const usage = { getMonthlyUsage: jest.fn() };
  const controller = new BillingController(
    billing as unknown as BillingService,
    usage as unknown as UsageService,
  );
  return { controller, billing, usage };
}

describe('BillingController', () => {
  it('listPlans() delegates to BillingService', async () => {
    const { controller, billing } = makeController();
    const plans = [{ id: 'plan-1' }];
    billing.listPlans.mockResolvedValue(plans);

    await expect(controller.listPlans()).resolves.toBe(plans);
  });

  it("getSubscription() reads the caller's own tenant", async () => {
    const { controller, billing } = makeController();
    const subscription = { id: 'sub-1' };
    billing.getForTenant.mockResolvedValue(subscription);

    await expect(controller.getSubscription(AUTH)).resolves.toBe(subscription);
    expect(billing.getForTenant).toHaveBeenCalledWith('tenant-a');
  });

  it("startCheckout() starts a subscription for the caller's own tenant", async () => {
    const { controller, billing } = makeController();
    const result = { checkoutUrl: 'https://checkout.stripe.com/s1' };
    billing.startSubscription.mockResolvedValue(result);

    await expect(
      controller.startCheckout(AUTH, {
        planId: 'plan-1',
        email: 'admin@example.com',
        successUrl: 'https://app.example.com/success',
        cancelUrl: 'https://app.example.com/cancel',
      }),
    ).resolves.toBe(result);
    expect(billing.startSubscription).toHaveBeenCalledWith(
      'tenant-a',
      'plan-1',
      'admin@example.com',
      'https://app.example.com/success',
      'https://app.example.com/cancel',
    );
  });

  it("getUsage() reads the caller's own tenant's current-month usage", async () => {
    const { controller, usage } = makeController();
    const report = { tenantId: 'tenant-a', messageCount: 10 };
    usage.getMonthlyUsage.mockResolvedValue(report);

    await expect(controller.getUsage(AUTH)).resolves.toBe(report);
    expect(usage.getMonthlyUsage).toHaveBeenCalledWith('tenant-a');
  });
});

describe('BillingController.openPortal()', () => {
  it('returns the portal URL for the calling tenant', async () => {
    const { controller, billing } = makeController();
    billing.createPortalSession.mockResolvedValue({
      portalUrl: 'https://billing.stripe.test/session/abc',
    });

    await expect(
      controller.openPortal(AUTH, { returnUrl: 'https://app.test/settings' }),
    ).resolves.toEqual({
      portalUrl: 'https://billing.stripe.test/session/abc',
    });

    // Tenant off the verified token, never off the body — same posture as
    // every other write here.
    expect(billing.createPortalSession).toHaveBeenCalledWith(
      'tenant-a',
      'https://app.test/settings',
    );
  });
});

describe('BillingController.cancel()', () => {
  it('cancels at period end and returns the updated subscription', async () => {
    const { controller, billing } = makeController();
    const record = { status: 'active', cancelAtPeriodEnd: true };
    billing.cancelSubscription.mockResolvedValue(record);

    await expect(controller.cancel(AUTH, { atPeriodEnd: true })).resolves.toBe(
      record,
    );
    expect(billing.cancelSubscription).toHaveBeenCalledWith('tenant-a', true);
  });

  it('passes an immediate cancellation through explicitly', async () => {
    const { controller, billing } = makeController();
    billing.cancelSubscription.mockResolvedValue({ status: 'canceled' });

    await controller.cancel(AUTH, { atPeriodEnd: false });

    expect(billing.cancelSubscription).toHaveBeenCalledWith('tenant-a', false);
  });
});
