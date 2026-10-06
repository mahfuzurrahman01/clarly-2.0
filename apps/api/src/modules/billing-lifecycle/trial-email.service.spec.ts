import type { AppConfigService, AppLoggerService } from '../core';
import type { PersistenceService } from '../persistence/persistence.service';
import type { BillingService } from '../billing/billing.service';
import type { EmailSender } from '../email/ports/email-sender.port';
import type { NotificationService } from '../notifications/notification.service';
import type { TenantAuthProvisioningPort } from '../onboarding/ports/tenant-auth-provisioning.port';
import { TrialEmailService } from './trial-email.service';

const TENANT_A = 'tenant-a';

function makeHarness(overrides: { trialEndingSoonDays?: number } = {}) {
  const persistence = {
    runAdminQuery: jest.fn(),
  } as unknown as PersistenceService;
  const getForTenant = jest.fn();
  const billing = { getForTenant } as unknown as BillingService;
  const record = jest.fn().mockResolvedValue(true);
  const notifications = { record } as unknown as NotificationService;
  const isEnabled = jest.fn().mockReturnValue(true);
  const send = jest.fn().mockResolvedValue({ providerMessageId: 'msg_1' });
  const email = { isEnabled, send } as unknown as EmailSender;
  const listTeamMembers = jest
    .fn()
    .mockResolvedValue([
      { userId: 'u1', email: 'admin@example.com', appRole: 'admin' },
    ]);
  const provisioning = {
    listTeamMembers,
  } as unknown as TenantAuthProvisioningPort;
  const config = {
    trialEndingSoonDays: overrides.trialEndingSoonDays ?? 3,
  } as AppConfigService;
  const logger = {
    log: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
    debug: jest.fn(),
  } as unknown as AppLoggerService;

  const service = new TrialEmailService(
    persistence,
    billing,
    notifications,
    email,
    provisioning,
    config,
    logger,
  );

  return {
    service,
    persistence,
    getForTenant,
    record,
    isEnabled,
    send,
    listTeamMembers,
  };
}

function subscription(overrides: Record<string, unknown> = {}) {
  return {
    id: 'sub-1',
    tenantId: TENANT_A,
    planId: 'plan-1',
    stripeCustomerId: null,
    stripeSubscriptionId: null,
    status: 'trialing',
    trialEndsAt: new Date(Date.now() + 2 * 24 * 60 * 60 * 1000),
    currentPeriodEnd: null,
    cancelAtPeriodEnd: false,
    comped: false,
    ...overrides,
  };
}

describe('TrialEmailService.sweep()', () => {
  it('emails and records trial_ending for a tenant inside the ending-soon window', async () => {
    const { service, persistence, getForTenant, record, send } = makeHarness();
    (persistence.runAdminQuery as jest.Mock).mockResolvedValue([
      { id: TENANT_A },
    ]);
    getForTenant.mockResolvedValue(subscription());

    const result = await service.sweep();

    expect(result).toEqual({ trialEndingEmailed: 1, trialExpiredEmailed: 0 });
    expect(record).toHaveBeenCalledWith(
      expect.objectContaining({ tenantId: TENANT_A, kind: 'trial_ending' }),
    );
    expect(send).toHaveBeenCalledWith(
      expect.objectContaining({ to: ['admin@example.com'] }),
    );
  });

  it('emails and records trial_expired for a tenant whose trial has ended', async () => {
    const { service, persistence, getForTenant, record } = makeHarness();
    (persistence.runAdminQuery as jest.Mock).mockResolvedValue([
      { id: TENANT_A },
    ]);
    getForTenant.mockResolvedValue(
      subscription({ trialEndsAt: new Date(Date.now() - 60_000) }),
    );

    const result = await service.sweep();

    expect(result).toEqual({ trialEndingEmailed: 0, trialExpiredEmailed: 1 });
    expect(record).toHaveBeenCalledWith(
      expect.objectContaining({ tenantId: TENANT_A, kind: 'trial_expired' }),
    );
  });

  it('does nothing for a tenant not near either boundary', async () => {
    const { service, persistence, getForTenant, record } = makeHarness();
    (persistence.runAdminQuery as jest.Mock).mockResolvedValue([
      { id: TENANT_A },
    ]);
    getForTenant.mockResolvedValue(
      subscription({
        trialEndsAt: new Date(Date.now() + 10 * 24 * 60 * 60 * 1000),
      }),
    );

    const result = await service.sweep();

    expect(result).toEqual({ trialEndingEmailed: 0, trialExpiredEmailed: 0 });
    expect(record).not.toHaveBeenCalled();
  });

  it('does nothing for a comped tenant', async () => {
    const { service, persistence, getForTenant, record } = makeHarness();
    (persistence.runAdminQuery as jest.Mock).mockResolvedValue([
      { id: TENANT_A },
    ]);
    getForTenant.mockResolvedValue(
      subscription({
        comped: true,
        trialEndsAt: new Date(Date.now() - 60_000),
      }),
    );

    await service.sweep();

    expect(record).not.toHaveBeenCalled();
  });

  it('does nothing for an active (non-trialing) tenant', async () => {
    const { service, persistence, getForTenant, record } = makeHarness();
    (persistence.runAdminQuery as jest.Mock).mockResolvedValue([
      { id: TENANT_A },
    ]);
    getForTenant.mockResolvedValue(subscription({ status: 'active' }));

    await service.sweep();

    expect(record).not.toHaveBeenCalled();
  });

  it('does nothing for a tenant with no subscription row', async () => {
    const { service, persistence, getForTenant, record } = makeHarness();
    (persistence.runAdminQuery as jest.Mock).mockResolvedValue([
      { id: TENANT_A },
    ]);
    getForTenant.mockResolvedValue(null);

    await service.sweep();

    expect(record).not.toHaveBeenCalled();
  });

  // Idempotency: NotificationService.record()'s ON CONFLICT DO NOTHING is
  // the mechanism — a rerun that finds the notification already recorded
  // must not email a second time.
  it('does not send a second email when the notification is already recorded (idempotent rerun)', async () => {
    const { service, persistence, getForTenant, record, send } = makeHarness();
    (persistence.runAdminQuery as jest.Mock).mockResolvedValue([
      { id: TENANT_A },
    ]);
    getForTenant.mockResolvedValue(subscription());
    record.mockResolvedValue(false); // already recorded by a prior sweep

    const result = await service.sweep();

    expect(result).toEqual({ trialEndingEmailed: 0, trialExpiredEmailed: 0 });
    expect(send).not.toHaveBeenCalled();
  });

  it('records the notification even when no mail provider is configured (never throws)', async () => {
    const { service, persistence, getForTenant, isEnabled, send } =
      makeHarness();
    (persistence.runAdminQuery as jest.Mock).mockResolvedValue([
      { id: TENANT_A },
    ]);
    getForTenant.mockResolvedValue(subscription());
    isEnabled.mockReturnValue(false);

    const result = await service.sweep();

    expect(result.trialEndingEmailed).toBe(1);
    expect(send).not.toHaveBeenCalled();
  });

  it('does not throw the sweep when the email send itself fails', async () => {
    const { service, persistence, getForTenant, send } = makeHarness();
    (persistence.runAdminQuery as jest.Mock).mockResolvedValue([
      { id: TENANT_A },
    ]);
    getForTenant.mockResolvedValue(subscription());
    send.mockRejectedValue(new Error('provider down'));

    await expect(service.sweep()).resolves.toEqual({
      trialEndingEmailed: 1,
      trialExpiredEmailed: 0,
    });
  });
});
