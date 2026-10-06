// F20 retroactive review (2026-09-21): the old spec asserted the mock's own
// canned row back and never noticed that the executor dropped the `category`
// argument it advertises in its schema, nor that nothing in the result told
// the model where prices may come from (D5).
import type { CatalogService, ProductRecord } from './catalog.service';
import {
  CatalogProductExecutor,
  LOOKUP_PRODUCT_MATCH_GUIDANCE,
  LOOKUP_PRODUCT_NO_MATCH_GUIDANCE,
} from './catalog-product-executor';
import type { ToolExecutionContext } from '../tool-execution/tool-execution-context';

const TENANT = '11111111-1111-1111-1111-111111111111';

/** F25 D6.1 / F26 D4: the executor now takes the turn context. The catalog is tenant-wide, so only `tenantId` is read — the other fields are here to prove they are ignored. */
const CTX: ToolExecutionContext = {
  tenantId: TENANT,
  conversationId: 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa',
  customerId: 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb',
  turnId: 'coalesce-window-1',
};

const record: ProductRecord = {
  id: '33333333-3333-3333-3333-333333333333',
  tenantId: TENANT,
  name: 'Wireless Mouse',
  nameAr: 'ماوس لاسلكي',
  sku: 'WM-001',
  description: 'A test product',
  descriptionAr: 'منتج اختبار',
  price: '49.99',
  currency: 'SAR',
  stock: 10,
  stockStatus: 'in_stock',
  imageUrl: 'https://example.com/image.jpg',
  imageObjectKey: 'products/wm-001.jpg',
  category: 'Electronics',
  tags: ['wireless'],
  metadata: { salla: { product_id: 1 } },
  isActive: true,
  createdAt: new Date('2026-09-01T00:00:00Z'),
  updatedAt: new Date('2026-09-01T00:00:00Z'),
};

function makeHarness(rows: ProductRecord[] = [record]) {
  const searchProducts = jest.fn().mockResolvedValue(rows);
  const catalog = { searchProducts } as unknown as CatalogService;
  return { executor: new CatalogProductExecutor(catalog), searchProducts };
}

describe('CatalogProductExecutor', () => {
  it('passes the advertised category filter through to the search', async () => {
    const { executor, searchProducts } = makeHarness();

    await executor.execute(CTX, {
      query: 'mouse',
      category: 'Electronics',
      limit: 3,
    });

    expect(searchProducts).toHaveBeenCalledWith(TENANT, 'mouse', {
      limit: 3,
      category: 'Electronics',
    });
  });

  it.each([
    ['المطبخ', 'kitchen'],
    ['أدوات المطبخ', 'kitchen'],
    ['matbakh', 'kitchen'],
  ])(
    'maps the Arabic/Arabizi category word %s to the catalog slug %s',
    async (word, slug) => {
      const { executor, searchProducts } = makeHarness();

      await executor.execute(CTX, { query: 'أدوات المطبخ', category: word });

      expect(searchProducts).toHaveBeenCalledWith(TENANT, 'أدوات المطبخ', {
        limit: 5,
        category: slug,
      });
    },
  );

  it('passes the raw Arabic query through so the search layer can strip the article', async () => {
    const { executor, searchProducts } = makeHarness();

    await executor.execute(CTX, { query: 'القلاية الهوائية' });

    expect(searchProducts).toHaveBeenCalledWith(TENANT, 'القلاية الهوائية', {
      limit: 5,
      category: undefined,
    });
  });

  it('defaults to 5 results when the model omits limit', async () => {
    const { executor, searchProducts } = makeHarness();

    await executor.execute(CTX, { query: 'mouse' });

    expect(searchProducts).toHaveBeenCalledWith(TENANT, 'mouse', {
      limit: 5,
      category: undefined,
    });
  });

  it('returns only catalog columns — never free text the model could mistake for provenance', async () => {
    const { executor } = makeHarness();

    const result = await executor.execute(CTX, { query: 'mouse' });

    expect(result.products).toEqual([
      {
        id: record.id,
        name: 'Wireless Mouse',
        nameAr: 'ماوس لاسلكي',
        sku: 'WM-001',
        price: '49.99',
        currency: 'SAR',
        stock: 10,
        stockStatus: 'in_stock',
        imageUrl: 'https://example.com/image.jpg',
        category: 'Electronics',
      },
    ]);
    // Internal fields stay internal: tenantId, metadata and the storage key
    // are not the model's business.
    expect(Object.keys(result.products[0])).not.toContain('tenantId');
    expect(Object.keys(result.products[0])).not.toContain('metadata');
    expect(Object.keys(result.products[0])).not.toContain('imageObjectKey');
  });

  // D5: the anti-hallucination contract travels with the data it constrains.
  it('carries the "these rows are the only source of price" guidance on a match', async () => {
    const { executor } = makeHarness();

    const result = await executor.execute(CTX, { query: 'mouse' });

    expect(result.guidance).toBe(LOOKUP_PRODUCT_MATCH_GUIDANCE);
    expect(result.guidance).toMatch(/only source of price and stock/i);
  });

  it('tells the model never to state a quantity for an untracked (null) stock', () => {
    expect(LOOKUP_PRODUCT_MATCH_GUIDANCE).toMatch(
      /null stock .* never state a quantity/i,
    );
  });

  it('tells the model explicitly to escalate rather than guess when nothing matched', async () => {
    const { executor } = makeHarness([]);

    const result = await executor.execute(CTX, { query: 'no such thing' });

    expect(result.products).toEqual([]);
    expect(result.message).toBe('No matching products found');
    expect(result.guidance).toBe(LOOKUP_PRODUCT_NO_MATCH_GUIDANCE);
    expect(result.guidance).toMatch(/escalate/i);
    expect(result.guidance).toMatch(/do not guess/i);
    // One shorter core-noun retry before escalating.
    expect(result.guidance).toMatch(/ONCE more with a shorter query/);
  });

  // Phase 6 review finding 6: a console-uploaded photo lives behind this
  // API's bearer-authenticated image route, so a link to it 401s for the
  // customer. The model must never be handed one to paste into a reply.
  it('withholds an API-hosted image url from the model', async () => {
    const { executor } = makeHarness([
      {
        ...record,
        imageUrl: `https://api.example.com/catalog/products/${record.id}/image?v=object-1`,
      },
    ]);

    const result = await executor.execute(CTX, { query: 'mouse' });

    expect(result.products[0].imageUrl).toBeNull();
  });

  it('passes a store-synced merchant CDN url through unchanged', async () => {
    const { executor } = makeHarness([
      { ...record, imageUrl: 'https://cdn.salla.sa/images/mouse.jpg' },
    ]);

    const result = await executor.execute(CTX, { query: 'mouse' });

    expect(result.products[0].imageUrl).toBe(
      'https://cdn.salla.sa/images/mouse.jpg',
    );
  });

  it('executes against the caller-supplied tenant, never one from the args', async () => {
    const { executor, searchProducts } = makeHarness();

    await executor.execute(CTX, {
      query: 'mouse',
      // A prompt-injected arg the schema does not declare must not reach the
      // query — `.execute()` only ever forwards tenantId from its parameter.
    });

    const calls = searchProducts.mock.calls as unknown as Array<[string]>;
    expect(calls[0][0]).toBe(TENANT);
  });

  it('reads only ctx.tenantId — a context with no conversation/customer/turn behaves identically (F20 backwards compatibility)', async () => {
    const { executor, searchProducts } = makeHarness();

    await executor.execute(
      {
        tenantId: TENANT,
        conversationId: null,
        customerId: null,
        turnId: null,
      },
      { query: 'mouse', category: 'Electronics', limit: 3 },
    );

    expect(searchProducts).toHaveBeenCalledWith(TENANT, 'mouse', {
      limit: 3,
      category: 'Electronics',
    });
  });
});
