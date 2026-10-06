// F20 retroactive review (2026-09-21): there was no controller spec at all,
// which is precisely why both P1s shipped — `GET /catalog/products/export`
// was shadowed by `@Get(':id')`, and every write endpoint took an unvalidated
// body. Both are HTTP-layer defects that no service-level test can see, so
// this spec drives the real controller over real HTTP (supertest) with the
// two services faked at their boundary.
import { NotFoundException, type INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import type { Server } from 'node:http';
import request from 'supertest';
import { EntitlementGuard } from '../billing/entitlement.guard';
import { CatalogImageService } from './catalog-image.service';
import { CatalogImportService } from './catalog-import.service';
import { CatalogController } from './catalog.controller';
import { CatalogService } from './catalog.service';
import { MAX_PRODUCT_IMAGE_BYTES } from './product-image';

const TENANT = '11111111-1111-1111-1111-111111111111';
const PRODUCT_ID = '33333333-3333-3333-3333-333333333333';

/** A real PNG header — the upload path checks magic numbers, not just labels. */
const PNG_BYTES = Buffer.from([
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x0d,
]);

const product = {
  id: PRODUCT_ID,
  tenantId: TENANT,
  name: 'Wireless Mouse',
  price: '49.99',
  currency: 'SAR',
  stock: 7,
  stockStatus: 'in_stock',
};

describe('CatalogController', () => {
  let app: INestApplication;
  const server = (): Server => app.getHttpServer() as Server;

  const catalog = {
    createProduct: jest.fn(),
    getProduct: jest.fn(),
    listProducts: jest.fn(),
    updateProduct: jest.fn(),
    deleteProduct: jest.fn(),
    searchProducts: jest.fn(),
  };
  const importService = { importCsv: jest.fn(), exportCsv: jest.fn() };
  const images = { uploadImage: jest.fn(), getImage: jest.fn() };

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({
      controllers: [CatalogController],
      providers: [
        { provide: CatalogService, useValue: catalog },
        { provide: CatalogImportService, useValue: importService },
        { provide: CatalogImageService, useValue: images },
      ],
    })
      // The guard's own behaviour is BillingModule's to test; what matters
      // here is that it is applied and that auth context reaches the routes.
      .overrideGuard(EntitlementGuard)
      .useValue({ canActivate: () => true })
      .compile();

    app = moduleRef.createNestApplication();
    // Stands in for TenantAuthMiddleware (applied by CatalogModule) — the
    // controller reads req.auth through @CurrentAuth().
    app.use((req: { auth?: unknown }, _res: unknown, next: () => void) => {
      req.auth = { tenantId: TENANT, userId: 'user-1', role: 'admin' };
      next();
    });
    await app.init();
  });

  afterAll(async () => {
    await app.close();
  });

  beforeEach(() => {
    jest.clearAllMocks();
    catalog.createProduct.mockResolvedValue(product);
    catalog.getProduct.mockResolvedValue(product);
    catalog.updateProduct.mockResolvedValue(product);
    catalog.deleteProduct.mockResolvedValue(true);
    catalog.listProducts.mockResolvedValue({ products: [product], total: 1 });
    catalog.searchProducts.mockResolvedValue([product]);
    importService.exportCsv.mockResolvedValue(
      'name,price\nWireless Mouse,49.99',
    );
    importService.importCsv.mockResolvedValue({
      imported: 1,
      updated: 0,
      errors: [],
    });
    images.uploadImage.mockResolvedValue({
      ...product,
      imageObjectKey: `${TENANT}/object-1`,
      imageUrl: `/catalog/products/${PRODUCT_ID}/image?v=object-1`,
    });
    images.getImage.mockResolvedValue({
      content: PNG_BYTES,
      mimeType: 'image/png',
    });
  });

  // THE P1. Nest matches routes in declaration order: with `@Get(':id')`
  // declared first, `/export` and `/search` bind to it as an id.
  describe('route ordering (literal paths must win over :id)', () => {
    it('GET /catalog/products/export returns CSV, not a product lookup', async () => {
      const res = await request(server())
        .get('/catalog/products/export')
        .expect(200);

      expect(res.body).toEqual({
        csv: 'name,price\nWireless Mouse,49.99',
      });
      expect(importService.exportCsv).toHaveBeenCalledWith(TENANT);
      expect(catalog.getProduct).not.toHaveBeenCalled();
    });

    it('GET /catalog/products/search runs a search, not a product lookup', async () => {
      const res = await request(server())
        .get('/catalog/products/search')
        .query({ q: 'mouse' })
        .expect(200);

      expect(res.body).toHaveLength(1);
      expect(catalog.searchProducts).toHaveBeenCalledWith(TENANT, 'mouse', {
        limit: undefined,
        category: undefined,
      });
      expect(catalog.getProduct).not.toHaveBeenCalled();
    });

    it('POST /catalog/products/import imports, and is not swallowed by another route', async () => {
      await request(server())
        .post('/catalog/products/import')
        .send({ csv: 'name,price\nA,1' })
        .expect(201);

      expect(importService.importCsv).toHaveBeenCalledWith(
        TENANT,
        'name,price\nA,1',
      );
    });
  });

  describe('validation', () => {
    it('rejects a create with no price (400, not a 500 or a NULL write)', async () => {
      const res = await request(server())
        .post('/catalog/products')
        .send({ name: 'Wireless Mouse' })
        .expect(400);

      expect(catalog.createProduct).not.toHaveBeenCalled();
      expect(JSON.stringify(res.body)).toContain('price');
    });

    it('rejects a negative price', async () => {
      await request(server())
        .post('/catalog/products')
        .send({ name: 'Mouse', price: -1 })
        .expect(400);
      expect(catalog.createProduct).not.toHaveBeenCalled();
    });

    it('rejects a non-numeric price rather than coercing it to 0', async () => {
      await request(server())
        .post('/catalog/products')
        .send({ name: 'Mouse', price: 'free' })
        .expect(400);
      expect(catalog.createProduct).not.toHaveBeenCalled();
    });

    it('rejects an empty name', async () => {
      await request(server())
        .post('/catalog/products')
        .send({ name: '   ', price: 10 })
        .expect(400);
      expect(catalog.createProduct).not.toHaveBeenCalled();
    });

    it('rejects an unknown currency and an unknown stock status', async () => {
      await request(server())
        .post('/catalog/products')
        .send({ name: 'Mouse', price: 10, currency: 'XYZ' })
        .expect(400);
      await request(server())
        .post('/catalog/products')
        .send({ name: 'Mouse', price: 10, stockStatus: 'maybe' })
        .expect(400);
      expect(catalog.createProduct).not.toHaveBeenCalled();
    });

    it('rejects unknown fields instead of silently dropping them', async () => {
      await request(server())
        .post('/catalog/products')
        .send({ name: 'Mouse', price: 10, isActive: false })
        .expect(400);
      expect(catalog.createProduct).not.toHaveBeenCalled();
    });

    it('rejects a tenantId supplied by the caller — tenant comes from the token, never the body', async () => {
      await request(server())
        .post('/catalog/products')
        .send({ name: 'Mouse', price: 10, tenantId: 'someone-else' })
        .expect(400);
      expect(catalog.createProduct).not.toHaveBeenCalled();
    });

    it('accepts a valid create and passes the parsed body through', async () => {
      await request(server())
        .post('/catalog/products')
        .send({
          name: 'Wireless Mouse',
          nameAr: 'ماوس لاسلكي',
          sku: 'WM-001',
          price: 49.99,
          currency: 'SAR',
          stock: 10,
          category: 'Electronics',
          tags: ['wireless'],
        })
        .expect(201);

      expect(catalog.createProduct).toHaveBeenCalledWith(
        TENANT,
        expect.objectContaining({ name: 'Wireless Mouse', price: 49.99 }),
      );
    });

    it('rejects an empty PATCH body rather than bumping updated_at for nothing', async () => {
      await request(server())
        .patch(`/catalog/products/${PRODUCT_ID}`)
        .send({})
        .expect(400);
      expect(catalog.updateProduct).not.toHaveBeenCalled();
    });

    it('rejects a non-UUID id with 400 before touching the service', async () => {
      await request(server()).get('/catalog/products/not-a-uuid').expect(400);
      expect(catalog.getProduct).not.toHaveBeenCalled();
    });

    it('requires a search term and caps the search limit', async () => {
      await request(server()).get('/catalog/products/search').expect(400);
      await request(server())
        .get('/catalog/products/search')
        .query({ q: 'mouse', limit: 5000 })
        .expect(400);
      expect(catalog.searchProducts).not.toHaveBeenCalled();
    });

    it('rejects a list limit above the page cap and a negative offset', async () => {
      await request(server())
        .get('/catalog/products')
        .query({ limit: 1000 })
        .expect(400);
      await request(server())
        .get('/catalog/products')
        .query({ offset: -1 })
        .expect(400);
      expect(catalog.listProducts).not.toHaveBeenCalled();
    });

    it('coerces valid numeric query params instead of passing strings down', async () => {
      await request(server())
        .get('/catalog/products')
        .query({ limit: '10', offset: '20', stock_status: 'low_stock' })
        .expect(200);

      expect(catalog.listProducts).toHaveBeenCalledWith(TENANT, {
        category: undefined,
        stockStatus: 'low_stock',
        search: undefined,
        limit: 10,
        offset: 20,
      });
    });

    it('rejects an import with no csv field', async () => {
      await request(server())
        .post('/catalog/products/import')
        .send({})
        .expect(400);
      expect(importService.importCsv).not.toHaveBeenCalled();
    });
  });

  describe('missing products are 404s, never 500s', () => {
    it('GET :id', async () => {
      catalog.getProduct.mockResolvedValue(null);
      const res = await request(server())
        .get(`/catalog/products/${PRODUCT_ID}`)
        .expect(404);
      expect((res.body as { message: string }).message).toContain(PRODUCT_ID);
    });

    it('PATCH :id', async () => {
      catalog.updateProduct.mockResolvedValue(null);
      await request(server())
        .patch(`/catalog/products/${PRODUCT_ID}`)
        .send({ stock: 1 })
        .expect(404);
    });

    it('DELETE :id', async () => {
      catalog.deleteProduct.mockResolvedValue(false);
      await request(server())
        .delete(`/catalog/products/${PRODUCT_ID}`)
        .expect(404);
    });

    it('DELETE :id is 204 on success', async () => {
      await request(server())
        .delete(`/catalog/products/${PRODUCT_ID}`)
        .expect(204);
      expect(catalog.deleteProduct).toHaveBeenCalledWith(TENANT, PRODUCT_ID);
    });
  });

  describe('product image upload', () => {
    it('stores an accepted image and returns the updated product', async () => {
      const res = await request(server())
        .post(`/catalog/products/${PRODUCT_ID}/image`)
        .attach('file', PNG_BYTES, {
          filename: 'mouse.png',
          contentType: 'image/png',
        })
        .expect(201);

      const [tenantId, productId, upload] = images.uploadImage.mock
        .calls[0] as [
        string,
        string,
        { filename: string; mimeType: string; content: Buffer },
      ];
      expect(tenantId).toBe(TENANT);
      expect(productId).toBe(PRODUCT_ID);
      expect(upload.filename).toBe('mouse.png');
      expect(upload.mimeType).toBe('image/png');
      // The exact bytes multer buffered, not just "a Buffer".
      expect(upload.content.equals(PNG_BYTES)).toBe(true);
      expect((res.body as { imageUrl: string }).imageUrl).toBe(
        `/catalog/products/${PRODUCT_ID}/image?v=object-1`,
      );
    });

    it('rejects a non-image type at the HTTP boundary, before the service is touched', async () => {
      const res = await request(server())
        .post(`/catalog/products/${PRODUCT_ID}/image`)
        .attach('file', Buffer.from('%PDF-1.4'), {
          filename: 'price-list.pdf',
          contentType: 'application/pdf',
        })
        .expect(400);

      expect(images.uploadImage).not.toHaveBeenCalled();
      expect(JSON.stringify(res.body)).toContain('image/png');
    });

    it('rejects image/svg+xml — an SVG is a script, not a photo', async () => {
      await request(server())
        .post(`/catalog/products/${PRODUCT_ID}/image`)
        .attach('file', Buffer.from('<svg onload="alert(1)"/>'), {
          filename: 'x.svg',
          contentType: 'image/svg+xml',
        })
        .expect(400);

      expect(images.uploadImage).not.toHaveBeenCalled();
    });

    it('aborts a file over the size ceiling with a 413, without buffering it whole', async () => {
      const oversized = Buffer.concat([
        PNG_BYTES,
        Buffer.alloc(MAX_PRODUCT_IMAGE_BYTES),
      ]);

      await request(server())
        .post(`/catalog/products/${PRODUCT_ID}/image`)
        .attach('file', oversized, {
          filename: 'huge.png',
          contentType: 'image/png',
        })
        .expect(413);

      expect(images.uploadImage).not.toHaveBeenCalled();
    });

    it('400s when no file part was sent at all', async () => {
      await request(server())
        .post(`/catalog/products/${PRODUCT_ID}/image`)
        .expect(400);

      expect(images.uploadImage).not.toHaveBeenCalled();
    });

    it('400s on a malformed product id rather than passing it to the service', async () => {
      await request(server())
        .post('/catalog/products/not-a-uuid/image')
        .attach('file', PNG_BYTES, {
          filename: 'mouse.png',
          contentType: 'image/png',
        })
        .expect(400);

      expect(images.uploadImage).not.toHaveBeenCalled();
    });

    it('surfaces the service 404 for a product this tenant does not own', async () => {
      images.uploadImage.mockRejectedValue(
        new NotFoundException(`Product ${PRODUCT_ID} not found`),
      );

      await request(server())
        .post(`/catalog/products/${PRODUCT_ID}/image`)
        .attach('file', PNG_BYTES, {
          filename: 'mouse.png',
          contentType: 'image/png',
        })
        .expect(404);
    });
  });

  describe('product image download', () => {
    it('serves the bytes with the recorded type and nosniff', async () => {
      const res = await request(server())
        .get(`/catalog/products/${PRODUCT_ID}/image`)
        .expect(200);

      expect(res.headers['content-type']).toContain('image/png');
      expect(res.headers['x-content-type-options']).toBe('nosniff');
      expect(Buffer.from(res.body as Buffer).equals(PNG_BYTES)).toBe(true);
      expect(images.getImage).toHaveBeenCalledWith(TENANT, PRODUCT_ID);
    });

    it('404s when the product has no stored image', async () => {
      images.getImage.mockRejectedValue(
        new NotFoundException('Product has no stored image'),
      );

      await request(server())
        .get(`/catalog/products/${PRODUCT_ID}/image`)
        .expect(404);
    });

    it('is not shadowed by GET /:id — the image route still reaches the image service', async () => {
      await request(server())
        .get(`/catalog/products/${PRODUCT_ID}/image`)
        .expect(200);

      expect(catalog.getProduct).not.toHaveBeenCalled();
    });
  });

  it('every route scopes to the tenant on the request, never to a body/query value', async () => {
    await request(server())
      .get('/catalog/products')
      .query({ category: 'Electronics' })
      .expect(200);
    await request(server())
      .get('/catalog/products/search')
      .query({ q: 'mouse', category: 'Electronics' })
      .expect(200);
    await request(server()).get(`/catalog/products/${PRODUCT_ID}`).expect(200);

    const firstArg = (mock: jest.Mock): unknown =>
      (mock.mock.calls as unknown as unknown[][])[0][0];

    for (const mock of [
      catalog.listProducts,
      catalog.searchProducts,
      catalog.getProduct,
    ]) {
      expect(firstArg(mock)).toBe(TENANT);
    }
  });
});
