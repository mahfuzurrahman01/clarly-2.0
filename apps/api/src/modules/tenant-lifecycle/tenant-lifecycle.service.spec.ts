import { ConflictException, NotFoundException } from '@nestjs/common';
import type { BillingService } from '../billing/billing.service';
import type { AppConfigService, AppLoggerService } from '../core';
import type { TenantAuthProvisioningPort } from '../onboarding/ports/tenant-auth-provisioning.port';
import type { PersistenceService } from '../persistence/persistence.service';
import type { PartitionLifecycleService } from '../retrieval/partition-lifecycle.service';
import type { ObjectStorage } from '../storage/ports/object-storage.port';
import type { TenantContextService } from '../tenant-context/tenant-context.service';
import type { TenantStatusService } from '../tenant-context/tenant-status.service';
import { TenantLifecycleService } from './tenant-lifecycle.service';

const TENANT = '11111111-1111-4111-8111-111111111111';

function chain(resolveWith: unknown): Record<string, unknown> {
  const node: Record<string, unknown> = {
    from: () => node,
    where: () => node,
    limit: () => node,
    set: () => node,
    then: (onFulfilled: (value: unknown) => unknown): Promise<unknown> =>
      Promise.resolve(resolveWith).then(onFulfilled),
  };
  return node;
}

function makeHarness(options: {
  /** Successive runAdminQuery() responses, in call order. */
  adminResponses?: unknown[];
  kbKeys?: { storageKey: string }[];
  mediaKeys?: { storageKey: string | null }[];
  members?: { userId: string; email: string }[];
  subscription?: unknown;
  storageThrows?: boolean;
  warn?: jest.Mock;
}) {
  const adminResponses = options.adminResponses ?? [];
  let adminCall = 0;
  /** Records every DELETE issued so the erasure ordering can be asserted. */
  const deletedTables: string[] = [];

  const runAdminQuery = jest.fn((fn: (db: unknown) => unknown) => {
    const response = adminResponses[adminCall++];
    const db = {
      select: () => chain(response),
      update: () => chain(response),
      delete: () => {
        deletedTables.push('tenants');
        return chain(response);
      },
    };
    return fn(db);
  });

  const withTenantTx = jest.fn((fn: (tx: unknown) => unknown) => {
    let selectCall = 0;
    const tx = {
      select: () => {
        const response =
          selectCall++ === 0
            ? (options.kbKeys ?? [])
            : (options.mediaKeys ?? []);
        return chain(response);
      },
    };
    return fn(tx);
  });

  const order: string[] = [];
  const storageDelete = jest.fn((key: string) => {
    order.push(`storage:${key}`);
    return options.storageThrows
      ? Promise.reject(new Error('bucket unreachable'))
      : Promise.resolve();
  });
  const dropPartitionForTenant = jest.fn(() => {
    order.push('partition');
    return Promise.resolve();
  });
  const cancelSubscription = jest.fn(() => {
    order.push('cancel');
    return Promise.resolve({});
  });
  const revokeTenantClaims = jest.fn((userId: string) => {
    order.push(`revoke:${userId}`);
    return Promise.resolve();
  });

  const invalidate = jest.fn();
  const error = jest.fn();
  const service = new TenantLifecycleService(
    { runAdminQuery } as unknown as PersistenceService,
    { withTenantTx } as unknown as TenantContextService,
    { invalidate, isClosed: jest.fn() } as unknown as TenantStatusService,
    { delete: storageDelete } as unknown as ObjectStorage,
    { dropPartitionForTenant } as unknown as PartitionLifecycleService,
    {
      getForTenant: jest.fn().mockResolvedValue(options.subscription ?? null),
      cancelSubscription,
    } as unknown as BillingService,
    {
      listTeamMembers: jest.fn().mockResolvedValue(options.members ?? []),
      revokeTenantClaims,
    } as unknown as TenantAuthProvisioningPort,
    { tenantPurgeGraceDays: 30 } as unknown as AppConfigService,
    {
      warn: options.warn ?? jest.fn(),
      log: jest.fn(),
      error,
    } as unknown as AppLoggerService,
  );

  return {
    service,
    order,
    deletedTables,
    storageDelete,
    dropPartitionForTenant,
    cancelSubscription,
    revokeTenantClaims,
    runAdminQuery,
    invalidate,
    error,
  };
}

describe('TenantLifecycleService.close()', () => {
  it('schedules erasure a grace period out, and deletes nothing now', async () => {
    const { service, deletedTables } = makeHarness({
      adminResponses: [[{ closedAt: null, purgeAfter: null }], []],
    });

    const closure = await service.close(TENANT);

    expect(closure.closedAt).toBeInstanceOf(Date);
    expect(closure.purgeAfter).toBeInstanceOf(Date);
    // 30 days out, per the configured grace period.
    const days =
      (closure.purgeAfter!.getTime() - closure.closedAt!.getTime()) /
      86_400_000;
    expect(Math.round(days)).toBe(30);
    // The whole point of a grace period: closing destroys nothing.
    expect(deletedTables).toEqual([]);
  });

  // Access must stop now, not after a cache TTL, for the admin who just acted.
  it('drops the cached open/closed status so the cutoff is immediate', async () => {
    const { service, invalidate } = makeHarness({
      adminResponses: [[{ closedAt: null, purgeAfter: null }], []],
    });

    await service.close(TENANT);

    expect(invalidate).toHaveBeenCalledWith(TENANT);
  });

  it('refuses to close an already-closed workspace', async () => {
    const { service } = makeHarness({
      adminResponses: [[{ closedAt: new Date(), purgeAfter: new Date() }]],
    });

    await expect(service.close(TENANT)).rejects.toBeInstanceOf(
      ConflictException,
    );
  });

  it('404s for a tenant that does not exist', async () => {
    const { service } = makeHarness({ adminResponses: [[]] });

    await expect(service.close(TENANT)).rejects.toBeInstanceOf(
      NotFoundException,
    );
  });
});

describe('TenantLifecycleService.reopen()', () => {
  it('clears both closure fields', async () => {
    const { service } = makeHarness({
      adminResponses: [[{ closedAt: new Date(), purgeAfter: new Date() }], []],
    });

    await expect(service.reopen(TENANT)).resolves.toEqual({
      tenantId: TENANT,
      closedAt: null,
      purgeAfter: null,
    });
  });

  it('refuses to reopen a workspace that is not closed', async () => {
    const { service } = makeHarness({
      adminResponses: [[{ closedAt: null, purgeAfter: null }]],
    });

    await expect(service.reopen(TENANT)).rejects.toBeInstanceOf(
      ConflictException,
    );
  });
});

describe('TenantLifecycleService.purgeTenant()', () => {
  // The ordering IS the feature. Storage keys live in rows that the tenant
  // cascade deletes, so anything read after the row delete is unrecoverable.
  it('deletes stored objects before the tenant row, never after', async () => {
    const { service, order, deletedTables } = makeHarness({
      kbKeys: [{ storageKey: 'kb/doc-1.pdf' }],
      mediaKeys: [{ storageKey: 'media/img-1.jpg' }],
      members: [{ userId: 'user-1', email: 'a@test' }],
      subscription: { stripeSubscriptionId: 'sub_1', status: 'active' },
      adminResponses: [[]],
    });

    await service.purgeTenant(TENANT);

    expect(order).toEqual([
      'storage:kb/doc-1.pdf',
      'storage:media/img-1.jpg',
      'partition',
      'cancel',
      'revoke:user-1',
    ]);
    expect(deletedTables).toEqual(['tenants']);
  });

  // kb_chunks is a PARTITION of a partitioned table, not a child row — no
  // cascade reaches it, so it would survive every offboarding as an orphan
  // holding exactly the content an erasure request is about.
  it('drops the vector partition, which no cascade would reach', async () => {
    const { service, dropPartitionForTenant } = makeHarness({
      adminResponses: [[]],
    });

    await service.purgeTenant(TENANT);

    expect(dropPartitionForTenant).toHaveBeenCalledWith(TENANT);
  });

  // Otherwise Stripe keeps charging an account that no longer exists.
  it('cancels an active subscription immediately, not at period end', async () => {
    const { service, cancelSubscription } = makeHarness({
      subscription: { stripeSubscriptionId: 'sub_1', status: 'active' },
      adminResponses: [[]],
    });

    await service.purgeTenant(TENANT);

    expect(cancelSubscription).toHaveBeenCalledWith(TENANT, false);
  });

  it('does not try to cancel when nothing is being billed', async () => {
    const { service, cancelSubscription } = makeHarness({
      subscription: { stripeSubscriptionId: null, status: 'incomplete' },
      adminResponses: [[]],
    });

    await service.purgeTenant(TENANT);

    expect(cancelSubscription).not.toHaveBeenCalled();
  });

  it('revokes claims for every member, not just the one who closed', async () => {
    const { service, revokeTenantClaims } = makeHarness({
      members: [
        { userId: 'user-1', email: 'a@test' },
        { userId: 'user-2', email: 'b@test' },
      ],
      adminResponses: [[]],
    });

    await service.purgeTenant(TENANT);

    expect(revokeTenantClaims).toHaveBeenCalledWith('user-1');
    expect(revokeTenantClaims).toHaveBeenCalledWith('user-2');
  });

  // A tenant who asked to be erased must be erased even if a dependency is
  // down. Half-offboarded and waiting on a human is worse than erased with a
  // loud log line.
  // The summary must not contradict the errors above it. An earlier version
  // counted attempts, so a run where every delete failed still announced the
  // objects were gone.
  it('says how many objects actually went, not how many were attempted', async () => {
    const warn = jest.fn();
    const { service } = makeHarness({
      kbKeys: [{ storageKey: 'kb/a.pdf' }, { storageKey: 'kb/b.pdf' }],
      storageThrows: true,
      adminResponses: [[]],
      warn,
    });

    await service.purgeTenant(TENANT);

    expect(warn).toHaveBeenCalledWith(
      expect.stringContaining('0/2 stored object(s) deleted'),
      'TenantLifecycleService',
    );
    expect(warn).toHaveBeenCalledWith(
      expect.stringContaining('SOME DATA SURVIVED'),
      'TenantLifecycleService',
    );
  });

  it('reports a clean run without the survivor warning', async () => {
    const warn = jest.fn();
    const { service } = makeHarness({
      kbKeys: [{ storageKey: 'kb/a.pdf' }],
      adminResponses: [[]],
      warn,
    });

    await service.purgeTenant(TENANT);

    const summary = (warn.mock.calls as unknown[][])
      .map((c) => String(c[0]))
      .find((m) => m.includes('stored object(s) deleted'));
    expect(summary).toContain('1/1 stored object(s) deleted');
    expect(summary).toContain('partition dropped');
    expect(summary).not.toContain('SOME DATA SURVIVED');
  });

  it('still deletes the tenant when object storage fails, and says what leaked', async () => {
    const { service, deletedTables, error } = makeHarness({
      kbKeys: [{ storageKey: 'kb/doc-1.pdf' }],
      storageThrows: true,
      adminResponses: [[]],
    });

    await service.purgeTenant(TENANT);

    expect(deletedTables).toEqual(['tenants']);
    expect(error).toHaveBeenCalledWith(
      expect.stringContaining('needs manual cleanup'),
      'TenantLifecycleService',
    );
  });

  it('ignores message rows that carry no attachment', async () => {
    const { service, storageDelete } = makeHarness({
      mediaKeys: [{ storageKey: null }, { storageKey: 'media/real.jpg' }],
      adminResponses: [[]],
    });

    await service.purgeTenant(TENANT);

    expect(storageDelete).toHaveBeenCalledTimes(1);
    expect(storageDelete).toHaveBeenCalledWith('media/real.jpg');
  });
});

describe('TenantLifecycleService.purgeDue()', () => {
  it('erases every tenant whose grace period has run out', async () => {
    const { service, runAdminQuery } = makeHarness({
      adminResponses: [
        [{ id: TENANT }, { id: '22222222-2222-4222-8222-222222222222' }],
        [],
        [],
      ],
    });

    const { purged } = await service.purgeDue(new Date());

    expect(purged).toHaveLength(2);
    expect(runAdminQuery).toHaveBeenCalled();
  });

  it('does nothing when no tenant is due', async () => {
    const { service } = makeHarness({ adminResponses: [[]] });

    await expect(service.purgeDue(new Date())).resolves.toEqual({
      purged: [],
    });
  });
});
