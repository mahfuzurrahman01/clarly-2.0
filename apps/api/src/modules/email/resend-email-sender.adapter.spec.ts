import type { AppConfigService } from '../core';
import { ResendEmailSender } from './resend-email-sender.adapter';

function makeConfig(
  overrides: Partial<AppConfigService> = {},
): AppConfigService {
  return {
    resendApiKey: 're_test_key',
    emailFromAddress: 'Clarly <alerts@clarly.test>',
    ...overrides,
  } as AppConfigService;
}

function jsonResponse(body: unknown, status = 200): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: () => Promise.resolve(body),
  } as unknown as Response;
}

describe('ResendEmailSender', () => {
  const fetchMock = jest.fn();

  beforeEach(() => {
    jest.clearAllMocks();
    global.fetch = fetchMock;
  });

  it('sends the from address and recipients Resend expects, authorised with the API key', async () => {
    fetchMock.mockResolvedValue(jsonResponse({ id: 'msg-1' }));

    const result = await new ResendEmailSender(makeConfig()).send({
      to: ['a@example.com', 'b@example.com'],
      subject: 'A ticket has gone unanswered',
      text: 'plain',
      html: '<p>rich</p>',
    });

    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('https://api.resend.com/emails');
    expect((init.headers as Record<string, string>).authorization).toBe(
      'Bearer re_test_key',
    );
    expect(JSON.parse(init.body as string)).toEqual({
      from: 'Clarly <alerts@clarly.test>',
      to: ['a@example.com', 'b@example.com'],
      subject: 'A ticket has gone unanswered',
      text: 'plain',
      html: '<p>rich</p>',
    });
    expect(result.providerMessageId).toBe('msg-1');
  });

  it('omits html entirely when there is none rather than sending an empty string', async () => {
    fetchMock.mockResolvedValue(jsonResponse({ id: 'msg-2' }));

    await new ResendEmailSender(makeConfig()).send({
      to: ['a@example.com'],
      subject: 's',
      text: 'plain',
    });

    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(JSON.parse(init.body as string)).not.toHaveProperty('html');
  });

  it('surfaces the reason Resend refused, which is the difference between a fixable misconfiguration and a mystery', async () => {
    fetchMock.mockResolvedValue(
      jsonResponse({ message: 'The clarly.test domain is not verified' }, 403),
    );

    await expect(
      new ResendEmailSender(makeConfig()).send({
        to: ['a@example.com'],
        subject: 's',
        text: 't',
      }),
    ).rejects.toThrow(/403.*not verified/);
  });

  it('refuses an empty recipient list instead of asking Resend to reject it', async () => {
    await expect(
      new ResendEmailSender(makeConfig()).send({
        to: [],
        subject: 's',
        text: 't',
      }),
    ).rejects.toThrow(/no recipients/);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
