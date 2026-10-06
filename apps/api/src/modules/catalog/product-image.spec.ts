// Feature 20 (Product Catalog & Stock): the upload guards for a product
// photo. Everything here runs on caller-controlled bytes and a
// caller-declared MIME type, so each rule is its own test.
import {
  MAX_PRODUCT_IMAGE_BYTES,
  PRODUCT_IMAGE_MIME_TYPES,
  hasProductImageSignature,
  isApiHostedProductImageUrl,
  isProductImageMimeType,
  productImageUrl,
} from './product-image';

/** Minimal byte prefixes — only the magic number matters to the check. */
const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00]);
const JPEG = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10]);
const GIF = Buffer.from('GIF89a-----');
const WEBP = Buffer.concat([
  Buffer.from('RIFF'),
  Buffer.from([0x1a, 0x00, 0x00, 0x00]),
  Buffer.from('WEBP'),
]);

describe('isProductImageMimeType', () => {
  it.each(PRODUCT_IMAGE_MIME_TYPES)('accepts %s', (mime) => {
    expect(isProductImageMimeType(mime)).toBe(true);
  });

  it('rejects the document types the KB accepts — this endpoint is images only', () => {
    expect(isProductImageMimeType('application/pdf')).toBe(false);
    expect(isProductImageMimeType('text/csv')).toBe(false);
  });

  it('rejects image/svg+xml, which is a script-execution vector, not a photo', () => {
    expect(isProductImageMimeType('image/svg+xml')).toBe(false);
  });

  it('is not fooled by a prefix or a parameterised type it did not allow', () => {
    expect(isProductImageMimeType('image/png; charset=utf-8')).toBe(false);
    expect(isProductImageMimeType('image/pngx')).toBe(false);
    expect(isProductImageMimeType('')).toBe(false);
  });
});

describe('hasProductImageSignature', () => {
  it.each([
    ['image/png', PNG],
    ['image/jpeg', JPEG],
    ['image/gif', GIF],
    ['image/webp', WEBP],
  ] as const)('accepts real %s bytes', (mime, bytes) => {
    expect(hasProductImageSignature(mime, bytes)).toBe(true);
  });

  it('rejects HTML bytes wearing an image/png label — the declared type is attacker-controlled', () => {
    expect(
      hasProductImageSignature('image/png', Buffer.from('<script>alert(1)')),
    ).toBe(false);
  });

  it('rejects bytes whose signature belongs to a different allowed type', () => {
    expect(hasProductImageSignature('image/png', JPEG)).toBe(false);
  });

  it('rejects a buffer too short to carry a signature at all', () => {
    expect(hasProductImageSignature('image/png', Buffer.from([0x89]))).toBe(
      false,
    );
    expect(hasProductImageSignature('image/webp', Buffer.alloc(0))).toBe(false);
  });

  it('rejects a RIFF container that is not WEBP', () => {
    const avi = Buffer.concat([
      Buffer.from('RIFF'),
      Buffer.from([0, 0, 0, 0]),
      Buffer.from('AVI '),
    ]);
    expect(hasProductImageSignature('image/webp', avi)).toBe(false);
  });
});

describe('productImageUrl', () => {
  const BASE = 'https://api.example.com';
  const PRODUCT = '33333333-3333-3333-3333-333333333333';
  const KEY =
    '11111111-1111-1111-1111-111111111111/abcdef01-2345-6789-abcd-ef0123456789';

  it('builds an absolute url when the API knows its own public base', () => {
    expect(productImageUrl('https://api.example.com', PRODUCT, KEY)).toBe(
      `https://api.example.com/catalog/products/${PRODUCT}/image?v=abcdef01-2345-6789-abcd-ef0123456789`,
    );
  });

  it('does not double the slash when the configured base carries a trailing one', () => {
    expect(productImageUrl('https://api.example.com/', PRODUCT, KEY)).toBe(
      `https://api.example.com/catalog/products/${PRODUCT}/image?v=abcdef01-2345-6789-abcd-ef0123456789`,
    );
  });

  it('varies with the storage key, so a replaced photo is not served from cache', () => {
    const first = productImageUrl(BASE, PRODUCT, `${'t'}/aaa`);
    const second = productImageUrl(BASE, PRODUCT, `${'t'}/bbb`);
    expect(first).not.toBe(second);
  });

  it('percent-encodes the cache-busting segment rather than trusting the key shape', () => {
    expect(productImageUrl(BASE, PRODUCT, 'tenant/a b&c')).toBe(
      `${BASE}/catalog/products/${PRODUCT}/image?v=a%20b%26c`,
    );
  });
});

// Phase 6 review finding 6: the executor hands `imageUrl` straight to the
// model. An API-hosted one 401s without a bearer, so the model could paste a
// dead link into a WhatsApp reply. One predicate answers "is this ours?" for
// both that caller and the console.
describe('isApiHostedProductImageUrl', () => {
  const PRODUCT = '33333333-3333-3333-3333-333333333333';

  it('recognises the absolute url this module builds', () => {
    expect(
      isApiHostedProductImageUrl(
        productImageUrl('https://api.example.com', PRODUCT, 'tenant/object-1'),
      ),
    ).toBe(true);
  });

  it('recognises a row written before the base url was required', () => {
    expect(
      isApiHostedProductImageUrl(
        `/catalog/products/${PRODUCT}/image?v=object-1`,
      ),
    ).toBe(true);
  });

  it('recognises one written under a different public host, so a rename does not leak links', () => {
    expect(
      isApiHostedProductImageUrl(
        `https://api-old.example.com/catalog/products/${PRODUCT}/image`,
      ),
    ).toBe(true);
  });

  it('passes a merchant CDN url through as not ours', () => {
    expect(
      isApiHostedProductImageUrl('https://cdn.salla.sa/images/mouse.jpg'),
    ).toBe(false);
  });

  it('does not treat an unparseable value as ours', () => {
    expect(isApiHostedProductImageUrl('')).toBe(false);
  });
});

describe('MAX_PRODUCT_IMAGE_BYTES', () => {
  it('is small enough that a catalog import cannot be used to fill a bucket', () => {
    expect(MAX_PRODUCT_IMAGE_BYTES).toBeLessThanOrEqual(10 * 1024 * 1024);
    expect(MAX_PRODUCT_IMAGE_BYTES).toBeGreaterThan(0);
  });
});
