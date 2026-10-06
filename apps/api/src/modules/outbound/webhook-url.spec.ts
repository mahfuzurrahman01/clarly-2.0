import { assertSafeWebhookUrl, UnsafeWebhookUrlError } from './webhook-url';

describe('assertSafeWebhookUrl()', () => {
  it('accepts an ordinary public https endpoint', async () => {
    await expect(
      assertSafeWebhookUrl('https://example.com/hooks/agent'),
    ).resolves.toBeUndefined();
  });

  it.each([
    [
      'http://example.com/hook',
      'plaintext would put customer data on the wire',
    ],
    ['https://user:pass@example.com/hook', 'embedded credentials'],
    ['not-a-url', 'malformed'],
  ])('refuses %s', async (url) => {
    await expect(assertSafeWebhookUrl(url)).rejects.toBeInstanceOf(
      UnsafeWebhookUrlError,
    );
  });

  it.each([
    'https://127.0.0.1/hook',
    'https://10.0.0.5/hook',
    'https://192.168.1.10/hook',
    'https://172.16.0.9/hook',
    // The one that turns SSRF into cloud credential theft.
    'https://169.254.169.254/latest/meta-data/',
    'https://[::1]/hook',
  ])(
    'refuses %s — an internal address is the whole reason this check exists',
    async (url) => {
      await expect(assertSafeWebhookUrl(url)).rejects.toBeInstanceOf(
        UnsafeWebhookUrlError,
      );
    },
  );

  it('refuses a hostname that does not resolve rather than assuming it is fine', async () => {
    await expect(
      assertSafeWebhookUrl('https://this-host-does-not-exist.invalid/hook'),
    ).rejects.toBeInstanceOf(UnsafeWebhookUrlError);
  });

  it('refuses localhost by name, not just by address', async () => {
    await expect(
      assertSafeWebhookUrl('https://localhost/hook'),
    ).rejects.toBeInstanceOf(UnsafeWebhookUrlError);
  });
});
