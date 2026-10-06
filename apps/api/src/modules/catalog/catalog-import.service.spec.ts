// F20 retroactive review (2026-09-21): the earlier version of this spec only
// checked that a well-formed row reached `upsertProduct`. The defects that
// mattered were in the rows it did NOT cover — an unparseable price silently
// became 0.00, and an unbounded paste became one DB round trip per row on a
// single HTTP request.
import { BadRequestException } from '@nestjs/common';
import type { CatalogService, ProductUpsertResult } from './catalog.service';
import {
  CatalogImportService,
  IMPORT_BATCH_SIZE,
  MAX_IMPORT_ROWS,
} from './catalog-import.service';

const TENANT = '11111111-1111-1111-1111-111111111111';
const HEADER =
  'name,name_ar,sku,price,currency,stock,category,description,description_ar,tags';

function makeCatalogService(options: { created?: boolean } = {}) {
  const upsertProductsDetailed = jest
    .fn()
    .mockImplementation(
      (
        tenantId: string,
        inputs: Array<Record<string, unknown>>,
      ): Promise<ProductUpsertResult[]> =>
        Promise.resolve(
          inputs.map(
            (input) =>
              ({
                created: options.created ?? true,
                product: { id: 'prod-1', tenantId, ...input },
              }) as unknown as ProductUpsertResult,
          ),
        ),
    );

  const service = {
    upsertProductsDetailed,
    listProducts: jest.fn().mockResolvedValue({ products: [], total: 0 }),
  } as unknown as CatalogService;

  return { service, upsertProductsDetailed };
}

/** The rows handed to the first batched upsert, typed (mock.calls is `any`). */
function firstBatch(mock: jest.Mock): Array<Record<string, unknown>> {
  const calls = mock.mock.calls as unknown as Array<
    [string, Array<Record<string, unknown>>]
  >;
  return calls[0][1];
}

function csvWithRows(count: number): string {
  const rows = Array.from(
    { length: count },
    (_, i) => `Product ${i},,SKU-${i},9.99,SAR,1,,,,`,
  );
  return [HEADER, ...rows].join('\n');
}

describe('CatalogImportService', () => {
  describe('importCsv', () => {
    it('rejects a CSV with no data rows', async () => {
      const { service } = makeCatalogService();
      const importer = new CatalogImportService(service);

      await expect(importer.importCsv(TENANT, '')).rejects.toThrow(
        BadRequestException,
      );
      await expect(importer.importCsv(TENANT, 'name,price')).rejects.toThrow(
        BadRequestException,
      );
    });

    // The most likely production failure per the F20 review: a 5k-row paste
    // was ~15k sequential queries inside one request.
    it('refuses an import above the row cap before doing any DB work', async () => {
      const { service, upsertProductsDetailed } = makeCatalogService();
      const importer = new CatalogImportService(service);

      await expect(
        importer.importCsv(TENANT, csvWithRows(MAX_IMPORT_ROWS + 1)),
      ).rejects.toThrow(/maximum per import is 1000/);
      expect(upsertProductsDetailed).not.toHaveBeenCalled();
    });

    it('writes in batches, not one round trip per row', async () => {
      const { service, upsertProductsDetailed } = makeCatalogService();
      const importer = new CatalogImportService(service);
      const rows = IMPORT_BATCH_SIZE * 2 + 5;

      const result = await importer.importCsv(TENANT, csvWithRows(rows));

      expect(upsertProductsDetailed).toHaveBeenCalledTimes(3);
      expect(firstBatch(upsertProductsDetailed)).toHaveLength(
        IMPORT_BATCH_SIZE,
      );
      expect(result.imported).toBe(rows);
      expect(result.errors).toEqual([]);
    });

    it('parses a full row, including Arabic fields and semicolon tags', async () => {
      const { service, upsertProductsDetailed } = makeCatalogService();
      const importer = new CatalogImportService(service);
      const csv = `${HEADER}
Test Product,منتج اختبار,TEST-001,99.99,SAR,10,electronics,A test product,منتج اختبار,test;product`;

      const result = await importer.importCsv(TENANT, csv);

      expect(result).toEqual({ imported: 1, updated: 0, errors: [] });
      expect(upsertProductsDetailed).toHaveBeenCalledWith(TENANT, [
        {
          name: 'Test Product',
          nameAr: 'منتج اختبار',
          sku: 'TEST-001',
          price: 99.99,
          currency: 'SAR',
          stock: 10,
          stockStatus: 'in_stock',
          category: 'electronics',
          description: 'A test product',
          descriptionAr: 'منتج اختبار',
          tags: ['test', 'product'],
        },
      ]);
    });

    // A free product is worse than a rejected row: the agent will quote it.
    it('rejects an unparseable price instead of importing it as 0', async () => {
      const { service, upsertProductsDetailed } = makeCatalogService();
      const importer = new CatalogImportService(service);
      const csv = `name,price\nMouse,free`;

      const result = await importer.importCsv(TENANT, csv);

      expect(result.imported).toBe(0);
      expect(result.errors).toEqual([
        { row: 2, message: 'Price "free" is not a number' },
      ]);
      expect(upsertProductsDetailed).not.toHaveBeenCalled();
    });

    it('rejects a missing price, a negative price and a fractional stock', async () => {
      const { service } = makeCatalogService();
      const importer = new CatalogImportService(service);
      const csv = `name,price,stock\nNo price,,1\nNegative,-5,1\nFraction,10,1.5`;

      const result = await importer.importCsv(TENANT, csv);

      expect(result.imported).toBe(0);
      expect(result.errors.map((e) => e.row)).toEqual([2, 3, 4]);
      expect(result.errors[0].message).toMatch(/price/i);
      expect(result.errors[1].message).toMatch(/non-negative/);
      expect(result.errors[2].message).toMatch(/whole number/);
    });

    it('rejects a currency or stock status the column constraint would not accept', async () => {
      const { service } = makeCatalogService();
      const importer = new CatalogImportService(service);
      const csv = `name,price,currency,stock_status\nA,10,XYZ,in_stock\nB,10,SAR,maybe`;

      const result = await importer.importCsv(TENANT, csv);

      expect(result.errors.map((e) => e.message)).toEqual([
        'Unsupported currency "XYZ"',
        'Unsupported stock status "maybe"',
      ]);
    });

    it('reports a bad row by its real line number and still imports the good ones', async () => {
      const { service, upsertProductsDetailed } = makeCatalogService();
      const importer = new CatalogImportService(service);
      const csv = `name,price\n,99.99\nGood,10`;

      const result = await importer.importCsv(TENANT, csv);

      expect(result.errors).toEqual([
        { row: 2, message: 'Missing required field: name' },
      ]);
      expect(result.imported).toBe(1);
      expect(firstBatch(upsertProductsDetailed)).toHaveLength(1);
    });

    // Two rows with the same SKU in one ON CONFLICT statement is a Postgres
    // error ("cannot affect row a second time") that would fail the batch.
    it('collapses duplicate SKUs in one file, last row winning', async () => {
      const { service, upsertProductsDetailed } = makeCatalogService();
      const importer = new CatalogImportService(service);
      const csv = `name,sku,price\nOld,WM-001,10\nNew,WM-001,20`;

      const result = await importer.importCsv(TENANT, csv);

      const batch = firstBatch(upsertProductsDetailed);
      expect(batch).toHaveLength(1);
      expect(batch[0]).toMatchObject({ name: 'New', price: 20 });
      expect(result.imported).toBe(1);
    });

    it('counts an upsert that hit an existing SKU as updated, not imported', async () => {
      const { service } = makeCatalogService({ created: false });
      const importer = new CatalogImportService(service);

      const result = await importer.importCsv(TENANT, csvWithRows(2));

      expect(result).toEqual({ imported: 0, updated: 2, errors: [] });
    });

    it('attributes a failed batch to every row in it rather than swallowing it', async () => {
      const { service, upsertProductsDetailed } = makeCatalogService();
      upsertProductsDetailed.mockRejectedValue(new Error('deadlock detected'));
      const importer = new CatalogImportService(service);

      const result = await importer.importCsv(TENANT, csvWithRows(2));

      expect(result.imported).toBe(0);
      expect(result.errors).toEqual([
        { row: 2, message: 'deadlock detected' },
        { row: 3, message: 'deadlock detected' },
      ]);
    });

    it('handles quoted fields containing commas', async () => {
      const { service, upsertProductsDetailed } = makeCatalogService();
      const importer = new CatalogImportService(service);
      const csv = `name,price,description\n"Mouse, wireless",10,"Small, light"`;

      await importer.importCsv(TENANT, csv);

      expect(firstBatch(upsertProductsDetailed)[0]).toMatchObject({
        name: 'Mouse, wireless',
        description: 'Small, light',
      });
    });
  });

  describe('exportCsv', () => {
    it('emits the documented header and escapes values containing commas', async () => {
      const { service } = makeCatalogService();
      (service.listProducts as jest.Mock).mockResolvedValue({
        products: [
          {
            name: 'Mouse, wireless',
            nameAr: null,
            sku: 'WM-001',
            price: '49.99',
            currency: 'SAR',
            stock: 3,
            stockStatus: 'in_stock',
            category: null,
            description: null,
            descriptionAr: null,
            tags: ['a', 'b'],
          },
        ],
        total: 1,
      });
      const importer = new CatalogImportService(service);

      const csv = await importer.exportCsv(TENANT);
      const [header, row] = csv.split('\n');

      expect(header).toBe(
        'name,name_ar,sku,price,currency,stock,stock_status,category,description,description_ar,tags',
      );
      expect(row).toBe('"Mouse, wireless",,WM-001,49.99,SAR,3,in_stock,,,,a;b');
    });
  });
});
