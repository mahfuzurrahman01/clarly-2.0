import type { TenantContextService } from '../tenant-context/tenant-context.service';
import { CustomerConsentService } from './customer-consent.service';

const TENANT = 'tenant-a';
const PHONE = '15551234567';

function makeRow(overrides: Record<string, unknown> = {}) {
  return {
    id: 'customer-1',
    tenantId: TENANT,
    phone: PHONE,
    name: null,
    tags: [],
    notes: null,
    optedOutAt: null,
    optOutSource: null,
    marketingOptedOutAt: null,
    createdAt: new Date(),
    updatedAt: new Date(),
    ...overrides,
  };
}

/** Calls through to the real withTenantTx callback so the query-building code actually runs. */
function makeHarness(responses: unknown[]) {
  let call = 0;
  const upserted: unknown[] = [];
  const updated: unknown[] = [];
  const withTenantTx = jest.fn((fn: (tx: unknown) => unknown) => {
    const response = responses[call++];
    const tx = {
      select: (selection?: unknown) => ({
        from: () => ({
          where: () => ({
            limit: () =>
              Promise.resolve(
                selection
                  ? (response as Record<string, unknown>[] | undefined)?.map(
                      (row) => {
                        const picked: Record<string, unknown> = {};
                        for (const key of Object.keys(selection)) {
                          picked[key] = row[key];
                        }
                        return picked;
                      },
                    )
                  : response,
              ),
          }),
        }),
      }),
      insert: () => ({
        values: (row: unknown) => {
          upserted.push(row);
          return {
            onConflictDoUpdate: () => ({
              returning: () => Promise.resolve(response),
            }),
          };
        },
      }),
      update: () => ({
        set: (patch: Record<string, unknown>) => {
          updated.push(patch);
          return {
            where: () => ({
              returning: () => Promise.resolve(response),
            }),
          };
        },
      }),
    };
    return fn(tx);
  });
  return {
    service: new CustomerConsentService({
      withTenantTx,
    } as unknown as TenantContextService),
    withTenantTx,
    upserted,
    updated,
  };
}

describe('CustomerConsentService.isOptedOut()', () => {
  it('is false for a customer who has not opted out', async () => {
    const { service } = makeHarness([[makeRow()]]);

    await expect(service.isOptedOut(TENANT, PHONE)).resolves.toBe(false);
  });

  it('is true once they have', async () => {
    const { service } = makeHarness([[makeRow({ optedOutAt: new Date() })]]);

    await expect(service.isOptedOut(TENANT, PHONE)).resolves.toBe(true);
  });

  // A customer we have never heard from cannot have asked us to stop.
  it('is false for a phone with no customer record', async () => {
    const { service } = makeHarness([[]]);

    await expect(service.isOptedOut(TENANT, PHONE)).resolves.toBe(false);
  });

  it('scopes the read to the tenant', async () => {
    const { service, withTenantTx } = makeHarness([[makeRow()]]);

    await service.isOptedOut(TENANT, PHONE);

    expect(withTenantTx).toHaveBeenCalledWith(expect.any(Function), TENANT);
  });
});

describe('CustomerConsentService.recordOptOut()', () => {
  it('stamps the time and how we know', async () => {
    const optedOutAt = new Date();
    const { service } = makeHarness([
      [],
      [makeRow({ optedOutAt, optOutSource: 'customer_keyword' })],
    ]);

    const result = await service.recordOptOut(
      TENANT,
      PHONE,
      'customer_keyword',
    );

    expect(result.optedOutAt).toEqual(optedOutAt);
    expect(result.optOutSource).toBe('customer_keyword');
  });

  // A customer can ask to stop before we have ever recorded a profile for
  // them. Losing that because no row existed is the exact failure this
  // feature prevents.
  it('creates the customer when the number is unknown', async () => {
    const { service, upserted } = makeHarness([[], [makeRow()]]);

    await service.recordOptOut(TENANT, PHONE, 'customer_keyword');

    expect(upserted).toEqual([
      expect.objectContaining({ tenantId: TENANT, phone: PHONE }),
    ]);
  });

  // The original timestamp is the one that matters as evidence; repeating
  // STOP must not move it.
  it('is idempotent — a second STOP does not reset the original time', async () => {
    const original = new Date('2026-01-01T00:00:00Z');
    const { service, upserted } = makeHarness([
      [makeRow({ optedOutAt: original, optOutSource: 'customer_keyword' })],
    ]);

    const result = await service.recordOptOut(
      TENANT,
      PHONE,
      'customer_keyword',
    );

    expect(result.optedOutAt).toEqual(original);
    expect(upserted).toEqual([]);
  });

  it('distinguishes an admin-recorded opt-out from a typed keyword', async () => {
    const { service, upserted } = makeHarness([
      [],
      [makeRow({ optedOutAt: new Date(), optOutSource: 'admin' })],
    ]);

    await service.recordOptOut(TENANT, PHONE, 'admin');

    expect(upserted[0]).toMatchObject({ optOutSource: 'admin' });
  });
});

describe('CustomerConsentService.recordOptIn()', () => {
  // There is no such thing as a half-remembered consent state.
  it('clears both the timestamp and the source', async () => {
    const { service, upserted } = makeHarness([[makeRow()]]);

    const result = await service.recordOptIn(TENANT, PHONE);

    expect(result.optedOutAt).toBeNull();
    expect(result.optOutSource).toBeNull();
    expect(upserted[0]).toMatchObject({
      optedOutAt: null,
      optOutSource: null,
    });
  });
});

describe('CustomerConsentService.isMarketingOptedOut() — F19', () => {
  it('is false when neither column is set', async () => {
    const { service } = makeHarness([[makeRow()]]);
    await expect(
      service.isMarketingOptedOut(TENANT, 'customer-1'),
    ).resolves.toBe(false);
  });

  it('is true when only marketingOptedOutAt is set', async () => {
    const { service } = makeHarness([
      [makeRow({ marketingOptedOutAt: new Date() })],
    ]);
    await expect(
      service.isMarketingOptedOut(TENANT, 'customer-1'),
    ).resolves.toBe(true);
  });

  it('is true when only the global optedOutAt is set — marketing consent inherits the global opt-out', async () => {
    const { service } = makeHarness([[makeRow({ optedOutAt: new Date() })]]);
    await expect(
      service.isMarketingOptedOut(TENANT, 'customer-1'),
    ).resolves.toBe(true);
  });

  it('is false for a customer id this tenant has never heard from', async () => {
    const { service } = makeHarness([[]]);
    await expect(service.isMarketingOptedOut(TENANT, 'nope')).resolves.toBe(
      false,
    );
  });
});

describe('CustomerConsentService.setMarketingOptOut() — F19', () => {
  it('sets marketingOptedOutAt on an existing customer row, by id', async () => {
    const { service, updated } = makeHarness([
      [makeRow({ marketingOptedOutAt: new Date() })],
    ]);

    const result = await service.setMarketingOptOut(TENANT, 'customer-1', true);

    expect(result?.marketingOptedOutAt).not.toBeNull();
    expect(updated[0]).toMatchObject({
      marketingOptedOutAt: expect.any(Date),
    });
  });

  it('clears marketingOptedOutAt when optedOut is false', async () => {
    const { service, updated } = makeHarness([[makeRow()]]);

    await service.setMarketingOptOut(TENANT, 'customer-1', false);

    expect(updated[0]).toMatchObject({ marketingOptedOutAt: null });
  });

  it('returns null when no row matches (caller 404s beforehand in practice)', async () => {
    const { service } = makeHarness([[]]);
    await expect(
      service.setMarketingOptOut(TENANT, 'nope', true),
    ).resolves.toBeNull();
  });
});

describe('CustomerConsentService.recordMarketingOptOut() — F19', () => {
  it('stamps marketingOptedOutAt without touching the global opt-out', async () => {
    const { service, upserted } = makeHarness([
      [],
      [makeRow({ marketingOptedOutAt: new Date() })],
    ]);

    const result = await service.recordMarketingOptOut(TENANT, PHONE);

    expect(result.marketingOptedOutAt).not.toBeNull();
    expect(result.optedOutAt).toBeNull();
    expect(upserted[0]).toMatchObject({
      marketingOptedOutAt: expect.any(Date),
    });
  });

  it('is idempotent — a second keyword does not move the original timestamp', async () => {
    const original = new Date('2026-01-01T00:00:00Z');
    const { service, upserted } = makeHarness([
      [makeRow({ marketingOptedOutAt: original })],
    ]);

    const result = await service.recordMarketingOptOut(TENANT, PHONE);

    expect(result.marketingOptedOutAt).toEqual(original);
    expect(upserted).toEqual([]);
  });

  it('creates the customer when the number is unknown', async () => {
    const { service, upserted } = makeHarness([[], [makeRow()]]);

    await service.recordMarketingOptOut(TENANT, PHONE);

    expect(upserted).toEqual([
      expect.objectContaining({ tenantId: TENANT, phone: PHONE }),
    ]);
  });
});
