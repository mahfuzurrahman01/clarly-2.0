import {
  parseAllowedSocialMediaUrl,
  SOCIAL_MEDIA_HOST_ALLOWLIST,
} from './social-media-url.policy';

describe('parseAllowedSocialMediaUrl (Gulf T6, D9)', () => {
  it.each([
    'https://scontent.xx.fbcdn.net/v/t1.15752-9/123_n.jpg?_nc_cat=1&oh=abc&oe=def',
    'https://scontent-lhr8-1.xx.fbcdn.net/v/t39/audioclip-1.mp4',
    'https://lookaside.fbsbx.com/ig_messaging_cdn/?asset_id=123&signature=abc',
    'https://scontent.cdninstagram.com/v/t51/123.jpg',
    'https://SCONTENT.XX.FBCDN.NET/upper.jpg',
  ])('accepts a Meta attachment CDN url: %s', (raw) => {
    expect(parseAllowedSocialMediaUrl(raw)).toBeInstanceOf(URL);
  });

  it.each([
    ['http downgrade', 'http://scontent.xx.fbcdn.net/x.jpg'],
    ['bare apex of a suffix host', 'https://fbcdn.net/x.jpg'],
    ['suffix without a dot boundary', 'https://evilfbcdn.net/x.jpg'],
    ['allowlisted name used as a subdomain', 'https://fbcdn.net.evil.com/x'],
    ['lookaside lookalike', 'https://lookaside.fbsbx.com.evil.com/x'],
    ['subdomain of the exact host', 'https://a.lookaside.fbsbx.com/x'],
    [
      'userinfo pointing at metadata',
      'https://scontent.fbcdn.net@169.254.169.254/',
    ],
    ['userinfo on an allowed host', 'https://user:pw@scontent.xx.fbcdn.net/x'],
    ['non-default port', 'https://scontent.xx.fbcdn.net:8443/x'],
    ['ip literal', 'https://127.0.0.1/x'],
    ['ipv6 literal', 'https://[::1]/x'],
    ['file scheme', 'file:///etc/passwd'],
    ['data scheme', 'data:image/png;base64,AAAA'],
    ['trailing-dot host', 'https://scontent.xx.fbcdn.net./x'],
    ['not a url', 'not a url'],
    ['empty', ''],
    ['unrelated host', 'https://example.com/x.jpg'],
  ])('refuses %s', (_label, raw) => {
    expect(parseAllowedSocialMediaUrl(raw)).toBeNull();
  });

  it('treats an explicit default port as the default port', () => {
    // WHATWG URL drops `:443` on https, so this is the same url as without it.
    expect(
      parseAllowedSocialMediaUrl('https://scontent.xx.fbcdn.net:443/x'),
    ).toBeInstanceOf(URL);
  });

  it('documents the allowlist exactly as D9 states it', () => {
    expect(SOCIAL_MEDIA_HOST_ALLOWLIST).toEqual([
      '*.fbcdn.net',
      '*.cdninstagram.com',
      'lookaside.fbsbx.com',
    ]);
  });
});
