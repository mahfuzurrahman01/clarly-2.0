import type { AppConfigService, AppLoggerService } from '../core';
import type {
  EmailMessage,
  EmailSendResult,
} from '../email/ports/email-sender.port';
import type { TenantAuthProvisioningPort } from '../onboarding/ports/tenant-auth-provisioning.port';
import { AlertEmailService } from './alert-email.service';

const TENANT_A = 'tenant-a';

function makeService(
  options: {
    enabled?: boolean;
    members?: { userId: string; email: string; appRole: 'admin' | 'agent' }[];
    consoleBaseUrl?: string;
  } = {},
) {
  // Captured through a typed implementation rather than read back off
  // `mock.calls`, which is `any` and would let a wrong-shaped message pass.
  const sent: EmailMessage[] = [];
  const send = jest.fn((message: EmailMessage): Promise<EmailSendResult> => {
    sent.push(message);
    return Promise.resolve({ providerMessageId: 'msg-1' });
  });
  const listTeamMembers = jest
    .fn()
    .mockResolvedValue(
      options.members ?? [
        { userId: 'u1', email: 'admin@example.com', appRole: 'admin' },
      ],
    );
  const logger = {
    log: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
    debug: jest.fn(),
  };

  const service = new AlertEmailService(
    {
      isEnabled: () => options.enabled ?? true,
      send,
    },
    { listTeamMembers } as unknown as TenantAuthProvisioningPort,
    {
      consoleBaseUrl: options.consoleBaseUrl ?? 'https://console.clarly.test',
    } as unknown as AppConfigService,
    logger as unknown as AppLoggerService,
  );

  return { service, send, sent, listTeamMembers, logger };
}

function alert(
  overrides: Partial<
    Parameters<AlertEmailService['sendCriticalAlert']>[0]
  > = {},
) {
  return {
    tenantId: TENANT_A,
    title: 'A ticket has gone unanswered for 42 minutes',
    body: 'This conversation was handed to a human 42 minutes ago.',
    entityType: 'ticket',
    entityId: 'ticket-1',
    ...overrides,
  };
}

describe('AlertEmailService', () => {
  it('mails the tenant admins when a ticket escalation goes unclaimed', async () => {
    const { service, send } = makeService();

    await expect(service.sendCriticalAlert(alert())).resolves.toBe(true);
    expect(send).toHaveBeenCalledWith(
      expect.objectContaining({
        to: ['admin@example.com'],
        subject: 'A ticket has gone unanswered for 42 minutes',
      }),
    );
  });

  it('does not mail agents — an escalation mailed to everyone is an escalation nobody owns', async () => {
    const { service, sent } = makeService({
      members: [
        { userId: 'u1', email: 'admin@example.com', appRole: 'admin' },
        { userId: 'u2', email: 'agent@example.com', appRole: 'agent' },
      ],
    });

    await service.sendCriticalAlert(alert());

    expect(sent[0].to).toEqual(['admin@example.com']);
  });

  it('skips silently when no provider is configured, so an unconfigured environment does not error on every alert', async () => {
    const { service, send, logger } = makeService({ enabled: false });

    await expect(service.sendCriticalAlert(alert())).resolves.toBe(false);
    expect(send).not.toHaveBeenCalled();
    expect(logger.error).not.toHaveBeenCalled();
  });

  it('warns rather than throwing when the tenant has no admin to mail — the notification row still stands', async () => {
    const { service, send, logger } = makeService({ members: [] });

    await expect(service.sendCriticalAlert(alert())).resolves.toBe(false);
    expect(send).not.toHaveBeenCalled();
    expect(logger.warn).toHaveBeenCalledWith(
      expect.stringContaining('no admin'),
      'AlertEmailService',
    );
  });

  it('never throws when the provider fails — this runs off an alert sweep that must survive it', async () => {
    const { service, send, logger } = makeService();
    send.mockRejectedValue(new Error('Resend is down'));

    await expect(service.sendCriticalAlert(alert())).resolves.toBe(false);
    expect(logger.error).toHaveBeenCalledWith(
      expect.stringContaining('Resend is down'),
      'AlertEmailService',
    );
  });

  it('links a ticket alert to the board and omits the link entirely when no console url is configured', async () => {
    const { service, sent } = makeService();
    await service.sendCriticalAlert(alert());
    expect(sent[0].text).toContain('https://console.clarly.test/tickets');

    const bare = makeService({ consoleBaseUrl: '' });
    await bare.service.sendCriticalAlert(alert());
    expect(bare.sent[0].text).not.toContain('Open the console');
    expect(bare.sent[0].html).not.toContain('<a href');
  });

  it('escapes the alert text in the html part rather than trusting it to be safe forever', async () => {
    const { service, sent } = makeService();

    await service.sendCriticalAlert(
      alert({ body: '<img src=x onerror="alert(1)">' }),
    );

    expect(sent[0].html).not.toContain('<img');
    expect(sent[0].html).toContain('&lt;img');
  });
});
