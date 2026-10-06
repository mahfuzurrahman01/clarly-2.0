import { DunningEmailService } from './dunning-email.service';

describe('DunningEmailService', () => {
  let service: DunningEmailService;
  let persistence: { runAdminQuery: jest.Mock };
  let billing: { getForTenant: jest.Mock };
  let notifications: { record: jest.Mock };
  let email: { isEnabled: jest.Mock; send: jest.Mock };
  let provisioning: { listTeamMembers: jest.Mock };
  let config: { trialEmailCheckIntervalMs: number };
  let logger: {
    log: jest.Mock;
    warn: jest.Mock;
    error: jest.Mock;
    debug: jest.Mock;
  };

  beforeEach(() => {
    persistence = { runAdminQuery: jest.fn() };
    billing = { getForTenant: jest.fn() };
    notifications = { record: jest.fn() };
    email = { isEnabled: jest.fn().mockReturnValue(true), send: jest.fn() };
    provisioning = { listTeamMembers: jest.fn() };
    config = { trialEmailCheckIntervalMs: 60_000 };
    logger = {
      log: jest.fn(),
      warn: jest.fn(),
      error: jest.fn(),
      debug: jest.fn(),
    };

    service = new DunningEmailService(
      persistence as never,
      billing as never,
      notifications as never,
      email,
      provisioning as never,
      config as never,
      logger as never,
    );
  });

  it('skips tenants without subscriptions', async () => {
    persistence.runAdminQuery.mockResolvedValue([{ id: 't1' }]);
    billing.getForTenant.mockResolvedValue(null);

    const result = await service.sweep();

    expect(result.dunningEmailed).toBe(0);
    expect(notifications.record).not.toHaveBeenCalled();
  });

  it('skips trialing tenants', async () => {
    persistence.runAdminQuery.mockResolvedValue([{ id: 't1' }]);
    billing.getForTenant.mockResolvedValue({
      id: 'sub1',
      status: 'trialing',
      comped: false,
    });

    const result = await service.sweep();

    expect(result.dunningEmailed).toBe(0);
    expect(notifications.record).not.toHaveBeenCalled();
  });

  it('skips comped tenants', async () => {
    persistence.runAdminQuery.mockResolvedValue([{ id: 't1' }]);
    billing.getForTenant.mockResolvedValue({
      id: 'sub1',
      status: 'past_due',
      comped: true,
    });

    const result = await service.sweep();

    expect(result.dunningEmailed).toBe(0);
  });

  it('emails past_due tenants', async () => {
    persistence.runAdminQuery.mockResolvedValue([{ id: 't1' }]);
    billing.getForTenant.mockResolvedValue({
      id: 'sub1',
      status: 'past_due',
      comped: false,
    });
    notifications.record.mockResolvedValue(true);
    provisioning.listTeamMembers.mockResolvedValue([
      { appRole: 'admin', email: 'admin@test.com' },
    ]);

    const result = await service.sweep();

    expect(result.dunningEmailed).toBe(1);
    expect(notifications.record).toHaveBeenCalledWith(
      expect.objectContaining({
        tenantId: 't1',
        kind: 'payment_failed',
        severity: 'critical',
        dedupKey: 'payment-failed-sub1',
      }),
    );
    expect(email.send).toHaveBeenCalledWith(
      expect.objectContaining({
        to: ['admin@test.com'],
        subject: 'Your Clarly subscription payment failed',
      }),
    );
  });

  it('skips already-notified tenants', async () => {
    persistence.runAdminQuery.mockResolvedValue([{ id: 't1' }]);
    billing.getForTenant.mockResolvedValue({
      id: 'sub1',
      status: 'past_due',
      comped: false,
    });
    notifications.record.mockResolvedValue(false);

    const result = await service.sweep();

    expect(result.dunningEmailed).toBe(0);
    expect(email.send).not.toHaveBeenCalled();
  });

  it('swallows email failures without crashing the sweep', async () => {
    persistence.runAdminQuery.mockResolvedValue([{ id: 't1' }, { id: 't2' }]);
    billing.getForTenant
      .mockResolvedValueOnce({
        id: 'sub1',
        status: 'past_due',
        comped: false,
      })
      .mockResolvedValueOnce({
        id: 'sub2',
        status: 'past_due',
        comped: false,
      });
    notifications.record.mockResolvedValue(true);
    provisioning.listTeamMembers.mockRejectedValue(new Error('network'));

    const result = await service.sweep();

    expect(result.dunningEmailed).toBe(2);
    expect(logger.error).toHaveBeenCalled();
  });

  it('warns when tenant has no admin email', async () => {
    persistence.runAdminQuery.mockResolvedValue([{ id: 't1' }]);
    billing.getForTenant.mockResolvedValue({
      id: 'sub1',
      status: 'past_due',
      comped: false,
    });
    notifications.record.mockResolvedValue(true);
    provisioning.listTeamMembers.mockResolvedValue([]);

    const result = await service.sweep();

    expect(result.dunningEmailed).toBe(1);
    expect(logger.warn).toHaveBeenCalledWith(
      expect.stringContaining('no admin with an email'),
      'DunningEmailService',
    );
    expect(email.send).not.toHaveBeenCalled();
  });

  it('logs when no email provider is configured', async () => {
    email.isEnabled.mockReturnValue(false);
    persistence.runAdminQuery.mockResolvedValue([{ id: 't1' }]);
    billing.getForTenant.mockResolvedValue({
      id: 'sub1',
      status: 'past_due',
      comped: false,
    });
    notifications.record.mockResolvedValue(true);

    const result = await service.sweep();

    expect(result.dunningEmailed).toBe(1);
    expect(logger.debug).toHaveBeenCalledWith(
      expect.stringContaining('no mail provider configured'),
      'DunningEmailService',
    );
  });
});
