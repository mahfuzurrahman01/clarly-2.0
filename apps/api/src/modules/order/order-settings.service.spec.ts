// F25 D9: "auto-mode eligibility: each of D1.5's five criteria failing
// independently -> 422 with that criterion named; all passing -> mode set,
// snapshot written."
//
// This is the gate on unattended sales. It is never granted automatically,
// never by the platform, and never as a side effect — so the shape of the test
// is: start from a tenant that passes everything, break exactly one thing, and
// assert the refusal names it.
import { UnprocessableEntityException } from '@nestjs/common';
import type { Clock } from '../core';
import type { TenantContextService } from '../tenant-context/tenant-context.service';
import {
  AUTO_MODE_MIN_DECIDED_ORDERS,
  OrderSettingsService,
  defaultOrderSettings,
} from './order-settings.service';

const TENANT = '00000000-0000-0000-0000-00000000000a';
const USER_ID = '22222222-2222-2222-2222-222222222222';
const NOW = new Date('2026-09-22T12:00:00.000Z');
const LONG_AGO = new Date('2026-08-01T12:00:00.000Z');
const YESTERDAY = new Date('2026-09-21T12:00:00.000Z');

interface World {
  settingsRow: Record<string, unknown> | null;
  decided: Array<{ status: string; count: number }>;
  activeProducts: number;
  connections: number;
  linkedProducts: number;
}

function healthyWorld(overrides: Partial<World> = {}): World {
  return {
    settingsRow: {
      tenantId: TENANT,
      mode: 'human_approval',
      codEnabled: true,
      approvalWindowHours: 24,
      autoEnabledAt: null,
      autoEnabledBy: null,
      autoEligibilitySnapshot: null,
      createdAt: LONG_AGO,
      updatedAt: LONG_AGO,
    },
    decided: [
      { status: 'confirmed', count: AUTO_MODE_MIN_DECIDED_ORDERS },
      { status: 'rejected', count: 0 },
    ],
    activeProducts: 5,
    connections: 0,
    linkedProducts: 0,
    ...overrides,
  };
}

/**
 * The service reaches the database through five distinct shapes. Rather than
 * emulating drizzle, the stub dispatches on which callback is running by
 * counting, in the fixed order `evaluateAutoEligibility` issues them:
 * settings, decided-orders, catalog-readiness (a triple), settings row age.
 */
function makeHarness(world: World, updated?: Record<string, unknown>) {
  // Return values in the exact sequence the service asks for them.
  const script: unknown[] = [];
  const pushEvaluationReads = () => {
    script.push(world.settingsRow ? [world.settingsRow] : []); // get()
    script.push(world.decided.map((row) => ({ ...row }))); // countDecidedOrders
    script.push([
      [{ count: world.activeProducts }],
      [{ count: world.connections }],
      [{ count: world.linkedProducts }],
    ]); // catalogReadiness (one tx, three selects)
    script.push(
      world.settingsRow ? [{ createdAt: world.settingsRow.createdAt }] : [],
    ); // settingsRowCreatedAt
  };

  return {
    world,
    script,
    pushEvaluationReads,
    pushUpdate: () => script.push([updated ?? world.settingsRow]),
    build: () => {
      const tx = jest.fn(() => Promise.resolve(script.shift()));
      const service = new OrderSettingsService(
        { withTenantTx: tx } as unknown as TenantContextService,
        { now: () => NOW } as unknown as Clock,
      );
      return { service, tx };
    },
  };
}

async function eligibilityFor(world: World) {
  const harness = makeHarness(world);
  // countDecidedOrders and catalogReadiness run inside a Promise.all, so the
  // two reads are issued before the tenure read — the script order below is
  // the order the service actually asks in.
  harness.script.push(world.settingsRow ? [world.settingsRow] : []);
  harness.script.push(world.decided.map((row) => ({ ...row })));
  harness.script.push([
    [{ count: world.activeProducts }],
    [{ count: world.connections }],
    [{ count: world.linkedProducts }],
  ]);
  harness.script.push(
    world.settingsRow ? [{ createdAt: world.settingsRow.createdAt }] : [],
  );
  const { service } = harness.build();
  return service.evaluateAutoEligibility(TENANT);
}

function failing(result: { criteria: Array<{ key: string; met: boolean }> }) {
  return result.criteria.filter((c) => !c.met).map((c) => c.key);
}

describe('defaultOrderSettings — absence IS a value (D1.1)', () => {
  it('reads a tenant with no row as disabled, failing closed', () => {
    expect(defaultOrderSettings(TENANT)).toMatchObject({
      mode: 'disabled',
      approvalWindowHours: 24,
    });
  });
});

describe('OrderSettingsService.evaluateAutoEligibility — D1.5', () => {
  it('passes every criterion for a tenant that has earned it', async () => {
    const result = await eligibilityFor(healthyWorld());
    expect(failing(result)).toEqual([]);
    expect(result.eligible).toBe(true);
  });

  it('fails the tenure criterion for a workspace that only enabled ordering yesterday', async () => {
    const world = healthyWorld();
    (world.settingsRow as Record<string, unknown>).createdAt = YESTERDAY;
    expect(failing(await eligibilityFor(world))).toEqual([
      'human_approval_tenure',
    ]);
  });

  it('fails the tenure criterion for a workspace that never enabled ordering', async () => {
    const result = await eligibilityFor(
      healthyWorld({ settingsRow: null, decided: [] }),
    );
    expect(failing(result)).toEqual(
      expect.arrayContaining(['human_approval_tenure']),
    );
    expect(result.eligible).toBe(false);
  });

  it('fails on too few decided orders, naming the number measured', async () => {
    const result = await eligibilityFor(
      healthyWorld({ decided: [{ status: 'confirmed', count: 3 }] }),
    );
    expect(failing(result)).toEqual(
      expect.arrayContaining(['decided_orders', 'rejection_rate']),
    );
    expect(
      result.criteria.find((c) => c.key === 'decided_orders')?.detail,
    ).toContain('3 so far');
  });

  it('fails on a rejection rate at or above 5%', async () => {
    const result = await eligibilityFor(
      healthyWorld({
        decided: [
          { status: 'confirmed', count: 18 },
          { status: 'rejected', count: 2 },
        ],
      }),
    );
    expect(failing(result)).toEqual(['rejection_rate']);
  });

  it('fails when the catalogue is empty', async () => {
    const result = await eligibilityFor(healthyWorld({ activeProducts: 0 }));
    expect(failing(result)).toEqual(['catalog_ready']);
  });

  it('fails when a store is connected but nothing is linked to it', async () => {
    // Otherwise every automatic order would silently fail its store push.
    const result = await eligibilityFor(
      healthyWorld({ connections: 1, linkedProducts: 0 }),
    );
    expect(failing(result)).toEqual(['catalog_ready']);
  });

  it('fails when cash on delivery is off — auto mode with no payment method is incoherent', async () => {
    const world = healthyWorld();
    (world.settingsRow as Record<string, unknown>).codEnabled = false;
    expect(failing(await eligibilityFor(world))).toEqual(['cod_enabled']);
  });
});

describe('OrderSettingsService.update', () => {
  it('refuses a move to auto with a 422 that names every failing criterion', async () => {
    const harness = makeHarness(healthyWorld({ activeProducts: 0 }));
    harness.pushEvaluationReads();
    const { service, tx } = harness.build();

    await expect(
      service.update(TENANT, USER_ID, { mode: 'auto' }),
    ).rejects.toBeInstanceOf(UnprocessableEntityException);

    // The refusal happens BEFORE any write.
    expect(tx).toHaveBeenCalledTimes(4);
  });

  it('writes the eligibility snapshot and the actor when auto is granted', async () => {
    const harness = makeHarness(healthyWorld(), {
      tenantId: TENANT,
      mode: 'auto',
      codEnabled: true,
      approvalWindowHours: 24,
      autoEnabledAt: NOW,
      autoEnabledBy: USER_ID,
      autoEligibilitySnapshot: { eligible: true },
      createdAt: LONG_AGO,
      updatedAt: NOW,
    });
    harness.pushEvaluationReads();
    harness.pushUpdate();
    const { service } = harness.build();

    await expect(
      service.update(TENANT, USER_ID, { mode: 'auto' }),
    ).resolves.toMatchObject({
      mode: 'auto',
      autoEnabledBy: USER_ID,
      autoEnabledAt: NOW,
    });
  });

  it('applies a non-auto change without evaluating eligibility at all', async () => {
    const harness = makeHarness(healthyWorld());
    harness.pushUpdate();
    const { service, tx } = harness.build();

    await service.update(TENANT, USER_ID, { mode: 'human_approval' });

    expect(tx).toHaveBeenCalledTimes(1);
  });
});

// QA 2026-10-05: the console renders the checklist in Arabic or English, so
// each criterion carries a stable `code` and the measured numbers beside the
// English `detail` (unchanged, kept as the fallback).
describe('OrderSettingsService.evaluateAutoEligibility — structured criteria', () => {
  function byKey(
    result: Awaited<ReturnType<typeof eligibilityFor>>,
    key: string,
  ) {
    const criterion = result.criteria.find((c) => c.key === key);
    if (!criterion) throw new Error(`no criterion ${key}`);
    return criterion;
  }

  it('reports tenure in days, counting only time spent in an approval mode', async () => {
    const world = healthyWorld();
    (world.settingsRow as Record<string, unknown>).createdAt = YESTERDAY;
    const tenure = byKey(await eligibilityFor(world), 'human_approval_tenure');

    expect(tenure).toMatchObject({
      code: 'human_approval_days',
      met: false,
      required: 7,
      actual: 1,
      unit: 'days',
      params: { mode: 'human_approval' },
    });
    expect(tenure.detail).toBe(
      'Requires 7 days in human-approval mode; enabled 1 day(s) ago in mode "human_approval".',
    );
  });

  it('counts zero tenure days for a workspace whose ordering is disabled, however old the row', async () => {
    const world = healthyWorld();
    (world.settingsRow as Record<string, unknown>).mode = 'disabled';
    const tenure = byKey(await eligibilityFor(world), 'human_approval_tenure');

    expect(tenure).toMatchObject({
      met: false,
      actual: 0,
      params: { mode: 'disabled' },
    });
  });

  it('reports the decided-order count against the minimum', async () => {
    const result = await eligibilityFor(
      healthyWorld({ decided: [{ status: 'confirmed', count: 3 }] }),
    );

    expect(byKey(result, 'decided_orders')).toMatchObject({
      code: 'approved_orders_count',
      met: false,
      required: 20,
      actual: 3,
      unit: 'orders',
    });
  });

  it('reports the rejection rate as a percentage with the counts behind it', async () => {
    const result = await eligibilityFor(
      healthyWorld({
        decided: [
          { status: 'confirmed', count: 18 },
          { status: 'rejected', count: 2 },
        ],
      }),
    );

    const rate = byKey(result, 'rejection_rate');
    expect(rate).toMatchObject({
      code: 'rejection_rate',
      met: false,
      required: 5,
      actual: 10,
      unit: 'percent',
      params: { rejected: 2, decided: 20 },
    });
    expect(rate.detail).toBe(
      'Requires a rejection rate below 5%; currently 10.0% (2 of 20).',
    );
  });

  it('names the empty-catalogue case active_products', async () => {
    const result = await eligibilityFor(healthyWorld({ activeProducts: 0 }));

    expect(byKey(result, 'catalog_ready')).toMatchObject({
      code: 'active_products',
      met: false,
      required: 1,
      actual: 0,
      unit: 'products',
    });
  });

  it('names a connected store with nothing linked products_linked', async () => {
    const result = await eligibilityFor(
      healthyWorld({ connections: 1, linkedProducts: 0 }),
    );

    expect(byKey(result, 'catalog_ready')).toMatchObject({
      code: 'products_linked',
      met: false,
      required: 1,
      actual: 0,
      unit: 'products',
      params: { activeProducts: 5, linkedProducts: 0, storesConnected: 1 },
    });
  });

  it('reports linked products when a store is connected and linked', async () => {
    const result = await eligibilityFor(
      healthyWorld({ connections: 1, linkedProducts: 4 }),
    );

    expect(byKey(result, 'catalog_ready')).toMatchObject({
      code: 'products_linked',
      met: true,
      actual: 4,
    });
  });

  it('reports store_connected = false (not required) when the catalogue lives only in Clarly', async () => {
    const result = await eligibilityFor(healthyWorld());

    const catalog = byKey(result, 'catalog_ready');
    expect(catalog).toMatchObject({
      code: 'store_connected',
      met: true,
      required: false,
      actual: false,
      unit: null,
      params: { activeProducts: 5, linkedProducts: 0, storesConnected: 0 },
    });
    expect(catalog.detail).toBe(
      '5 active product(s); no store connected, orders stay in Clarly.',
    );
  });

  it('reports cash on delivery as a boolean requirement', async () => {
    const world = healthyWorld();
    (world.settingsRow as Record<string, unknown>).codEnabled = false;

    expect(byKey(await eligibilityFor(world), 'cod_enabled')).toMatchObject({
      code: 'cod_enabled',
      met: false,
      required: true,
      actual: false,
      unit: null,
    });
  });

  it('puts the same structured fields on the 422 failedCriteria', async () => {
    const harness = makeHarness(healthyWorld({ activeProducts: 0 }));
    harness.pushEvaluationReads();
    const { service } = harness.build();

    const error = await service
      .update(TENANT, USER_ID, { mode: 'auto' })
      .catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(UnprocessableEntityException);
    const body = (error as UnprocessableEntityException).getResponse() as {
      failedCriteria: unknown[];
    };
    expect(body.failedCriteria).toEqual([
      {
        criterion: 'catalog_ready',
        detail:
          'Requires at least one active catalogue product; there are none.',
        code: 'active_products',
        required: 1,
        actual: 0,
        unit: 'products',
        params: { activeProducts: 0, linkedProducts: 0, storesConnected: 0 },
      },
    ]);
  });
});
