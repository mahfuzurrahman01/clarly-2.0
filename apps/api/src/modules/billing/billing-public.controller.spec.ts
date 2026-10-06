import type { BillingService } from './billing.service';
import { BillingPublicController } from './billing-public.controller';

describe('BillingPublicController.listPublicPlans()', () => {
  it('delegates to BillingService.listPublicPlans() and returns its result as-is', async () => {
    const publicPlans = [
      {
        id: 'plan-1',
        name: 'Pro',
        monthlyMessageLimit: 1000,
        monthlySpendCapUsd: 50,
        trialDays: 14,
      },
    ];
    const billing = {
      listPublicPlans: jest.fn().mockResolvedValue(publicPlans),
    };
    const controller = new BillingPublicController(
      billing as unknown as BillingService,
    );

    await expect(controller.listPublicPlans()).resolves.toBe(publicPlans);
    expect(billing.listPublicPlans).toHaveBeenCalledWith();
  });
});
