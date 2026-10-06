import type { AppConfigService } from '../core';
import {
  MediaRejectedError,
  MediaTooLargeError,
} from '../channel/ports/media-download.errors';
import { SocialMediaFetcher } from './social-media.fetcher';

const CDN_URL =
  'https://scontent.xx.fbcdn.net/v/t1.15752-9/photo.jpg?oh=SIGNATURE&oe=EXPIRY';
const JPEG = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10]);

function makeFetcher(maxBytes = 1024) {
  return new SocialMediaFetcher({
    inboundMediaMaxBytes: maxBytes,
    bspRequestTimeoutMs: 5000,
  } as unknown as AppConfigService);
}

function respond(
  body: BodyInit | null,
  init: { status?: number; headers?: Record<string, string> } = {},
): Response {
  return new Response(body, {
    status: init.status ?? 200,
    headers: init.headers ?? { 'content-type': 'image/jpeg' },
  });
}

describe('SocialMediaFetcher (Gulf T6, D9)', () => {
  let fetchSpy: jest.SpyInstance;

  beforeEach(() => {
    fetchSpy = jest.spyOn(global, 'fetch');
  });

  afterEach(() => {
    fetchSpy.mockRestore();
  });

  it('downloads an allowlisted CDN url with no auth header and redirects refused', async () => {
    fetchSpy.mockResolvedValue(respond(JPEG));

    const media = await makeFetcher().fetch(CDN_URL);

    expect(media).toEqual({ content: JPEG, mimeType: 'image/jpeg' });
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    const [url, init] = fetchSpy.mock.calls[0] as [URL, RequestInit];
    expect(url.toString()).toBe(CDN_URL);
    expect(init.redirect).toBe('error');
    expect(init.method).toBe('GET');
    // The CDN signature is the credential; a page token must never go here.
    expect(init.headers).toBeUndefined();
    expect(init.signal).toBeInstanceOf(AbortSignal);
  });

  it('normalizes the content type it reports', async () => {
    fetchSpy.mockResolvedValue(
      respond(Buffer.from('OggS....'), {
        headers: { 'content-type': 'Audio/OGG; codecs=opus' },
      }),
    );

    const media = await makeFetcher().fetch(
      'https://lookaside.fbsbx.com/ig_messaging_cdn/?asset_id=1&signature=x',
    );

    expect(media.mimeType).toBe('audio/ogg');
  });

  it.each([
    'http://scontent.xx.fbcdn.net/x.jpg',
    'https://169.254.169.254/latest/meta-data/',
    'https://evilfbcdn.net/x.jpg',
    '',
  ])('never opens a connection for an off-allowlist url: %s', async (raw) => {
    await expect(makeFetcher().fetch(raw)).rejects.toBeInstanceOf(
      MediaRejectedError,
    );
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('keeps the url signature out of the rejection reason', async () => {
    const error = await makeFetcher()
      .fetch('https://example.com/x?signature=SECRET')
      .then(
        () => new Error('expected a rejection'),
        (e: unknown) => e as Error,
      );

    expect(error).toBeInstanceOf(MediaRejectedError);
    expect(error.message).toContain('example.com');
    expect(error.message).not.toContain('SECRET');
  });

  it('turns a refused redirect into a rejection, not a retry', async () => {
    fetchSpy.mockRejectedValue(
      new TypeError('fetch failed', {
        cause: new Error('unexpected redirect'),
      }),
    );

    await expect(makeFetcher().fetch(CDN_URL)).rejects.toBeInstanceOf(
      MediaRejectedError,
    );
  });

  it('lets a network failure through for the queue to retry', async () => {
    fetchSpy.mockRejectedValue(
      new TypeError('fetch failed', { cause: new Error('ECONNRESET') }),
    );

    const error = await makeFetcher()
      .fetch(CDN_URL)
      .catch((e: unknown) => e);

    expect(error).toBeInstanceOf(TypeError);
  });

  it.each([403, 404, 410])(
    'rejects a dead or forbidden url (HTTP %i) without retrying',
    async (status) => {
      fetchSpy.mockResolvedValue(respond('nope', { status }));

      await expect(makeFetcher().fetch(CDN_URL)).rejects.toBeInstanceOf(
        MediaRejectedError,
      );
    },
  );

  it.each([429, 500, 503])('leaves HTTP %i retryable', async (status) => {
    fetchSpy.mockResolvedValue(respond('busy', { status }));

    const error = await makeFetcher()
      .fetch(CDN_URL)
      .then(
        () => new Error('expected a rejection'),
        (e: unknown) => e as Error,
      );

    expect(error).toBeInstanceOf(Error);
    expect(error).not.toBeInstanceOf(MediaRejectedError);
    expect(error.message).toContain(`HTTP ${status}`);
    expect(error.message).not.toContain('SIGNATURE');
  });

  it.each(['text/html', 'application/octet-stream', 'image/svg+xml', ''])(
    'rejects content type "%s"',
    async (contentType) => {
      fetchSpy.mockResolvedValue(
        respond(JPEG, {
          headers: contentType ? { 'content-type': contentType } : {},
        }),
      );

      await expect(makeFetcher().fetch(CDN_URL)).rejects.toBeInstanceOf(
        MediaRejectedError,
      );
    },
  );

  it('refuses up front when Content-Length is over the cap', async () => {
    fetchSpy.mockResolvedValue(
      respond(JPEG, {
        headers: { 'content-type': 'image/jpeg', 'content-length': '5000' },
      }),
    );

    const error = await makeFetcher(1024)
      .fetch(CDN_URL)
      .then(
        () => null,
        (e: unknown) => e as MediaTooLargeError,
      );

    expect(error).toBeInstanceOf(MediaTooLargeError);
    expect(error?.sizeBytes).toBe(5000);
    expect(error?.limitBytes).toBe(1024);
  });

  it('stops reading a body that grows past the cap without a Content-Length', async () => {
    let pulls = 0;
    const endless = new ReadableStream<Uint8Array>({
      pull(controller) {
        pulls += 1;
        controller.enqueue(new Uint8Array(512));
      },
    });
    fetchSpy.mockResolvedValue(respond(endless));

    await expect(makeFetcher(1024).fetch(CDN_URL)).rejects.toBeInstanceOf(
      MediaTooLargeError,
    );
    // It stopped shortly after the cap instead of buffering forever.
    expect(pulls).toBeLessThan(10);
  });

  it('accepts a body exactly at the cap', async () => {
    fetchSpy.mockResolvedValue(respond(Buffer.alloc(1024, 1)));

    const media = await makeFetcher(1024).fetch(CDN_URL);

    expect(media.content.byteLength).toBe(1024);
  });
});
