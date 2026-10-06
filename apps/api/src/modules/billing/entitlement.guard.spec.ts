import { ExecutionContext, ForbiddenException } from '@nestjs/common';
import type { Request } from 'express';
import type { TenantAuthContext } from '../auth/jwt-claims';
import type { TenantSubscriptionRecord } from './billing.dto';
import { BillingService } from './billing.service';
import { EntitlementGuard } from './entitlement.guard';

function makeContext(auth?: TenantAuthContext): ExecutionContext {
  const request = { auth } as Request;
  return {
    switchToHttp: () => ({ getRequest: () => request }),
  } as unknown as ExecutionContext;
}

function makeSubscription(
  status: TenantSubscriptionRecord['status'],
  overrides: Partial<TenantSubscriptionRecord> = {},
): TenantSubscriptionRecord {
  return {
    id: 'sub-1',
    tenantId: 'tenant-1',
    planId: 'plan-1',
    stripeCustomerId: 'cus_1',
    stripeSubscriptionId: 'sub_stripe_1',
    status,
    trialEndsAt: null,
    currentPeriodEnd: null,
    cancelAtPeriodEnd: false,
    comped: false,
    ...overrides,
  };
}

const ADMIN_AUTH: TenantAuthContext = {
  userId: 'user-1',
  tenantId: 'tenant-1',
  role: 'authenticated',
  appRole: 'admin',
};

function makeGuard(getForTenant: jest.Mock): {
  guard: EntitlementGuard;
} {
  const billing = { getForTenant } as unknown as BillingService;
  return { guard: new EntitlementGuard(billing) };
}

describe('EntitlementGuard', () => {
  it("allows the request through when req.auth is missing (not this guard's job)", async () => {
    const { guard } = makeGuard(jest.fn());

    await expect(guard.canActivate(makeContext(undefined))).resolves.toBe(true);
  });

  it('allows a tenant with no subscription row (billing not enabled for this tenant)', async () => {
    const getForTenant = jest.fn().mockResolvedValue(null);
    const { guard } = makeGuard(getForTenant);
    const auth: TenantAuthContext = {
      userId: 'user-1',
      tenantId: 'tenant-1',
      role: 'authenticated',
      appRole: 'admin',
    };

    await expect(guard.canActivate(makeContext(auth))).resolves.toBe(true);
    expect(getForTenant).toHaveBeenCalledWith('tenant-1');
  });

  it('allows an active subscription', async () => {
    const { guard } = makeGuard(
      jest.fn().mockResolvedValue(makeSubscription('active')),
    );

    await expect(guard.canActivate(makeContext(ADMIN_AUTH))).resolves.toBe(
      true,
    );
  });

  it('allows a trial that has not ended yet', async () => {
    const { guard } = makeGuard(
      jest.fn().mockResolvedValue(
        makeSubscription('trialing', {
          trialEndsAt: new Date(Date.now() + 60_000),
        }),
      ),
    );

    await expect(guard.canActivate(makeContext(ADMIN_AUTH))).resolves.toBe(
      true,
    );
  });

  // Same gate as the respond-path worker: a local trial row never gets a
  // Stripe webhook, so its status stays `trialing` after trial_ends_at.
  it('throws ForbiddenException for a trial whose trial_ends_at has passed', async () => {
    const { guard } = makeGuard(
      jest.fn().mockResolvedValue(
        makeSubscription('trialing', {
          stripeCustomerId: null,
          stripeSubscriptionId: null,
          trialEndsAt: new Date(Date.now() - 60_000),
        }),
      ),
    );

    await expect(guard.canActivate(makeContext(ADMIN_AUTH))).rejects.toThrow(
      'Subscription is not active',
    );
  });

  // The launch backfill (migration 0046) comps pre-existing tenants with
  // status `incomplete` — they must keep full console access.
  it.each(['incomplete', 'past_due', 'canceled'] as const)(
    'allows a comped tenant whose status is %s',
    async (status) => {
      const { guard } = makeGuard(
        jest.fn().mockResolvedValue(makeSubscription(status, { comped: true })),
      );

      await expect(guard.canActivate(makeContext(ADMIN_AUTH))).resolves.toBe(
        true,
      );
    },
  );

  it.each(['past_due', 'canceled', 'incomplete'] as const)(
    'throws ForbiddenException when subscription status is %s',
    async (status) => {
      const getForTenant = jest
        .fn()
        .mockResolvedValue(makeSubscription(status));
      const { guard } = makeGuard(getForTenant);
      const auth: TenantAuthContext = {
        userId: 'user-1',
        tenantId: 'tenant-1',
        role: 'authenticated',
        appRole: 'admin',
      };

      await expect(guard.canActivate(makeContext(auth))).rejects.toThrow(
        ForbiddenException,
      );
    },
  );
});
