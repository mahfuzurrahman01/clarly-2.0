// Feature 20 (Product Catalog & Stock): the product-photo path.
//
// The two failure modes worth pinning are ownership and orphaned bytes: a
// product id belonging to another tenant must 404 *before* anything is
// written to storage, and replacing a photo must not leave the previous
// object paying rent in the bucket forever.
import {
  BadRequestException,
  NotFoundException,
  ServiceUnavailableException,
} from '@nestjs/common';
import type { AppConfigService, AppLoggerService } from '../core';
import { CatalogImageService } from './catalog-image.service';
import type { CatalogService, ProductRecord } from './catalog.service';

const TENANT = '11111111-1111-1111-1111-111111111111';
const PRODUCT_ID = '33333333-3333-3333-3333-333333333333';
const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x01]);

function productRecord(overrides: Partial<ProductRecord> = {}): ProductRecord {
  return {
    id: PRODUCT_ID,
    tenantId: TENANT,
    name: 'Wireless Mouse',
    nameAr: null,
    sku: 'WM-001',
    description: null,
    descriptionAr: null,
    price: '49.99',
    currency: 'SAR',
    stock: 7,
    stockStatus: 'in_stock',
    imageUrl: null,
    imageObjectKey: null,
    category: 'Electronics',
    tags: [],
    metadata: {},
    isActive: true,
    createdAt: new Date('2026-09-01T00:00:00Z'),
    updatedAt: new Date('2026-09-01T00:00:00Z'),
    ...overrides,
  };
}

function makeHarness(options: { apiPublicBaseUrl?: string } = {}) {
  const catalog = {
    getProduct: jest.fn(),
    updateProduct: jest.fn(),
  };
  const storage = {
    upload: jest.fn(),
    download: jest.fn(),
    delete: jest.fn(),
  };
  const logger = { log: jest.fn(), warn: jest.fn(), error: jest.fn() };
  // Configured by default: without an absolute base URL uploadImage 503s
  // outright, which is its own test below.
  const config = {
    apiPublicBaseUrl: options.apiPublicBaseUrl ?? 'https://api.example.com',
  };

  const service = new CatalogImageService(
    catalog as unknown as CatalogService,
    storage,
    config as AppConfigService,
    logger as unknown as AppLoggerService,
  );

  return { service, catalog, storage, logger };
}

const upload = { filename: 'mouse.png', mimeType: 'image/png', content: PNG };

describe('CatalogImageService.uploadImage', () => {
  it('stores the bytes under the tenant prefix the port owns and records the key on the product', async () => {
    const h = makeHarness({ apiPublicBaseUrl: 'https://api.example.com' });
    h.catalog.getProduct.mockResolvedValue(productRecord());
    h.storage.upload.mockResolvedValue({
      storageKey: `${TENANT}/object-1`,
      sizeBytes: PNG.byteLength,
    });
    h.catalog.updateProduct.mockImplementation((_t, _id, input) =>
      Promise.resolve(productRecord(input as Partial<ProductRecord>)),
    );

    const result = await h.service.uploadImage(TENANT, PRODUCT_ID, upload);

    // The port derives `${tenantId}/${uuid}` itself; the filename is
    // metadata only and never becomes a path.
    expect(h.storage.upload).toHaveBeenCalledWith(TENANT, 'mouse.png', PNG);
    expect(h.catalog.updateProduct).toHaveBeenCalledWith(
      TENANT,
      PRODUCT_ID,
      expect.objectContaining({
        imageObjectKey: `${TENANT}/object-1`,
        imageUrl: `https://api.example.com/catalog/products/${PRODUCT_ID}/image?v=object-1`,
      }),
    );
    expect(result.imageObjectKey).toBe(`${TENANT}/object-1`);
  });

  it('remembers the content type, because the download route must not re-sniff it', async () => {
    const h = makeHarness();
    h.catalog.getProduct.mockResolvedValue(
      productRecord({ metadata: { storeExternalId: 'sku-9' } }),
    );
    h.storage.upload.mockResolvedValue({
      storageKey: `${TENANT}/object-1`,
      sizeBytes: 9,
    });
    h.catalog.updateProduct.mockResolvedValue(productRecord());

    await h.service.uploadImage(TENANT, PRODUCT_ID, upload);

    const [, , input] = h.catalog.updateProduct.mock.calls[0] as [
      string,
      string,
      { metadata: Record<string, unknown> },
    ];
    expect(input.metadata).toEqual({
      // Merged, never replaced: `metadata` is one jsonb column shared with
      // store sync, and a blind overwrite would drop storeExternalId and
      // silently break F24's stock webhooks.
      storeExternalId: 'sku-9',
      imageMimeType: 'image/png',
      imageSizeBytes: 9,
    });
  });

  // Phase 6 review findings 3+4: `image_url` is persisted and resolved by
  // clients that never see this API's config. The old root-relative fallback
  // stored a row nothing could load and raised no error anywhere — a blank
  // thumbnail forever. Refusing the upload is the only visible failure.
  it('503s instead of storing an unresolvable image_url when API_PUBLIC_BASE_URL is unset', async () => {
    const h = makeHarness({ apiPublicBaseUrl: '' });
    h.catalog.getProduct.mockResolvedValue(productRecord());

    await expect(
      h.service.uploadImage(TENANT, PRODUCT_ID, upload),
    ).rejects.toBeInstanceOf(ServiceUnavailableException);
    expect(h.storage.upload).not.toHaveBeenCalled();
    expect(h.catalog.updateProduct).not.toHaveBeenCalled();
  });

  it('404s for a product in another tenant WITHOUT writing anything to storage', async () => {
    const h = makeHarness();
    h.catalog.getProduct.mockResolvedValue(null);

    await expect(
      h.service.uploadImage(TENANT, PRODUCT_ID, upload),
    ).rejects.toBeInstanceOf(NotFoundException);
    expect(h.storage.upload).not.toHaveBeenCalled();
  });

  it('404s rather than 500s when the row disappears between the read and the write', async () => {
    const h = makeHarness();
    h.catalog.getProduct.mockResolvedValue(productRecord());
    h.storage.upload.mockResolvedValue({
      storageKey: `${TENANT}/object-1`,
      sizeBytes: 9,
    });
    h.catalog.updateProduct.mockResolvedValue(null);

    await expect(
      h.service.uploadImage(TENANT, PRODUCT_ID, upload),
    ).rejects.toBeInstanceOf(NotFoundException);
  });

  it('rejects bytes that do not match the declared type before storing them', async () => {
    const h = makeHarness();
    h.catalog.getProduct.mockResolvedValue(productRecord());

    await expect(
      h.service.uploadImage(TENANT, PRODUCT_ID, {
        filename: 'evil.png',
        mimeType: 'image/png',
        content: Buffer.from('<script>alert(1)</script>'),
      }),
    ).rejects.toBeInstanceOf(BadRequestException);
    expect(h.storage.upload).not.toHaveBeenCalled();
  });

  it('deletes the object the previous photo used, so a re-upload does not leak bytes', async () => {
    const h = makeHarness();
    h.catalog.getProduct.mockResolvedValue(
      productRecord({ imageObjectKey: `${TENANT}/old-object` }),
    );
    h.storage.upload.mockResolvedValue({
      storageKey: `${TENANT}/object-2`,
      sizeBytes: 9,
    });
    h.catalog.updateProduct.mockResolvedValue(productRecord());

    await h.service.uploadImage(TENANT, PRODUCT_ID, upload);

    expect(h.storage.delete).toHaveBeenCalledWith(`${TENANT}/old-object`);
  });

  it('keeps the upload successful when the old object cannot be deleted, and says so', async () => {
    const h = makeHarness();
    h.catalog.getProduct.mockResolvedValue(
      productRecord({ imageObjectKey: `${TENANT}/old-object` }),
    );
    h.storage.upload.mockResolvedValue({
      storageKey: `${TENANT}/object-2`,
      sizeBytes: 9,
    });
    h.catalog.updateProduct.mockResolvedValue(productRecord());
    h.storage.delete.mockRejectedValue(new Error('bucket unreachable'));

    await expect(
      h.service.uploadImage(TENANT, PRODUCT_ID, upload),
    ).resolves.toBeDefined();
    // Never swallowed: the leaked object is a real (small) operational fact.
    expect(h.logger.warn).toHaveBeenCalled();
  });
});

describe('CatalogImageService.getImage', () => {
  it('serves the stored bytes with the content type recorded at upload time', async () => {
    const h = makeHarness();
    h.catalog.getProduct.mockResolvedValue(
      productRecord({
        imageObjectKey: `${TENANT}/object-1`,
        metadata: { imageMimeType: 'image/webp' },
      }),
    );
    h.storage.download.mockResolvedValue(PNG);

    await expect(h.service.getImage(TENANT, PRODUCT_ID)).resolves.toEqual({
      content: PNG,
      mimeType: 'image/webp',
    });
  });

  it('falls back to octet-stream rather than echoing an unrecognised recorded type', async () => {
    const h = makeHarness();
    h.catalog.getProduct.mockResolvedValue(
      productRecord({
        imageObjectKey: `${TENANT}/object-1`,
        metadata: { imageMimeType: 'text/html' },
      }),
    );
    h.storage.download.mockResolvedValue(PNG);

    const result = await h.service.getImage(TENANT, PRODUCT_ID);
    expect(result.mimeType).toBe('application/octet-stream');
  });

  it('404s when the product has no uploaded photo', async () => {
    const h = makeHarness();
    h.catalog.getProduct.mockResolvedValue(productRecord());

    await expect(h.service.getImage(TENANT, PRODUCT_ID)).rejects.toBeInstanceOf(
      NotFoundException,
    );
    expect(h.storage.download).not.toHaveBeenCalled();
  });

  it("404s for another tenant's product, indistinguishably from a missing one", async () => {
    const h = makeHarness();
    h.catalog.getProduct.mockResolvedValue(null);

    await expect(h.service.getImage(TENANT, PRODUCT_ID)).rejects.toBeInstanceOf(
      NotFoundException,
    );
  });
});
