// Feature 20 (Product Catalog & Stock): what counts as a product photo, and
// where one is served from.
//
// Kept out of the controller (unlike KbDocumentController's inline constants)
// because three places need the same answer: the upload route's 400s, the
// download route's Content-Type, and the spec that pins both.
//
// The declared MIME type on a multipart part is caller-controlled, so it is
// only half the check — `hasProductImageSignature` verifies the bytes agree.
// Together with the allowlist (which excludes `image/svg+xml`, an
// script-execution vector rather than a photo) and the `nosniff` header on
// the download route, that is what keeps "upload a product image" from being
// "host arbitrary content on the API's origin".

/** The four raster formats WhatsApp itself accepts for outbound media. */
export const PRODUCT_IMAGE_MIME_TYPES = [
  'image/jpeg',
  'image/png',
  'image/webp',
  'image/gif',
] as const;

export type ProductImageMimeType = (typeof PRODUCT_IMAGE_MIME_TYPES)[number];

export const PRODUCT_IMAGE_MIME_TYPES_DESCRIPTION =
  PRODUCT_IMAGE_MIME_TYPES.join(', ');

/**
 * 5 MB. A product photo is a thumbnail in a console list and an outbound
 * WhatsApp image; neither needs more, and a catalog is thousands of rows
 * wide, so the per-file ceiling is also the bucket's growth ceiling.
 */
export const MAX_PRODUCT_IMAGE_BYTES = 5 * 1024 * 1024;

export function isProductImageMimeType(
  mimeType: string,
): mimeType is ProductImageMimeType {
  return (PRODUCT_IMAGE_MIME_TYPES as readonly string[]).includes(mimeType);
}

/** Magic numbers, one per allowed type. WEBP is a RIFF container, so it needs both ends checked. */
const SIGNATURES: Record<ProductImageMimeType, (bytes: Buffer) => boolean> = {
  'image/jpeg': (bytes) =>
    bytes.length >= 3 &&
    bytes[0] === 0xff &&
    bytes[1] === 0xd8 &&
    bytes[2] === 0xff,
  'image/png': (bytes) =>
    bytes.length >= 8 &&
    bytes
      .subarray(0, 8)
      .equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])),
  'image/gif': (bytes) =>
    bytes.length >= 6 &&
    (bytes.subarray(0, 6).toString('latin1') === 'GIF87a' ||
      bytes.subarray(0, 6).toString('latin1') === 'GIF89a'),
  'image/webp': (bytes) =>
    bytes.length >= 12 &&
    bytes.subarray(0, 4).toString('latin1') === 'RIFF' &&
    bytes.subarray(8, 12).toString('latin1') === 'WEBP',
};

/**
 * Whether the bytes really are of the declared type. A caller can label
 * anything `image/png`; only this says whether the stored object is a photo
 * or an HTML page waiting to be served back off our own origin.
 */
export function hasProductImageSignature(
  mimeType: string,
  bytes: Buffer,
): boolean {
  if (!isProductImageMimeType(mimeType)) return false;
  return SIGNATURES[mimeType](bytes);
}

/**
 * The canonical URL for a product's image, stored in `products.image_url`.
 *
 * `?v=<object key>` is a cache buster: the path is stable across re-uploads
 * (it is keyed by product id, not by object), so without it a merchant who
 * replaces a photo keeps seeing the old one.
 *
 * `apiPublicBaseUrl` MUST be absolute — CatalogImageService refuses the
 * upload when `API_PUBLIC_BASE_URL` is unset rather than storing a
 * root-relative value here. `image_url` is persisted and read back by
 * clients that have no idea which origin wrote it, so a relative string
 * would be a permanently wrong row the console renders as a blank
 * thumbnail with no error raised anywhere.
 *
 * Note this is an AUTHENTICATED url (the route sits behind the same tenant
 * auth as the rest of CatalogController), so it is a console-facing address,
 * not one to hand to a BSP as outbound media. Store-synced products keep
 * whatever public CDN url the store gave them; this only ever overwrites
 * `image_url` for a photo the merchant uploaded here.
 */
export function productImageUrl(
  apiPublicBaseUrl: string,
  productId: string,
  storageKey: string,
): string {
  const base = apiPublicBaseUrl.replace(/\/+$/, '');
  const version = encodeURIComponent(storageKey.split('/').pop() ?? storageKey);
  return `${base}${PRODUCT_IMAGE_PATH_PREFIX}${productId}/image?v=${version}`;
}

const PRODUCT_IMAGE_PATH_PREFIX = '/catalog/products/';

/**
 * Whether `imageUrl` is an address WE serve (the authenticated route above)
 * rather than the public CDN url a store sync gave us.
 *
 * The single place that question is answered, because two callers need the
 * same answer for opposite reasons: CatalogProductExecutor must NOT put one
 * of ours into a tool result (the model would paste a link that 401s for the
 * customer — see the header note above), and the console must fetch one of
 * ours with a bearer instead of dropping it in an `<img src>`.
 *
 * Matched on path shape rather than against the configured base URL so that
 * a row written under a different `API_PUBLIC_BASE_URL` (a renamed host, a
 * restored dump) is still recognised. A merchant CDN that happened to serve
 * `/catalog/products/<x>/image` would be a false positive; that direction is
 * the safe one — we withhold an image rather than hand out a dead link.
 */
export function isApiHostedProductImageUrl(imageUrl: string): boolean {
  let path: string;
  try {
    // Second arg makes a root-relative value parse too: rows predating the
    // absolute-base requirement above still exist in deployed databases.
    path = new URL(imageUrl, 'http://product-image.invalid').pathname;
  } catch {
    return false;
  }
  return path.startsWith(PRODUCT_IMAGE_PATH_PREFIX) && path.endsWith('/image');
}
