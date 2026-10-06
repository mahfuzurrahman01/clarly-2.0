import type { TenantContextService } from '../tenant-context/tenant-context.service';
import { WebhookDedupService } from './webhook-dedup.service';

function makeTenantContext(withTenantTx: jest.Mock): TenantContextService {
  return { withTenantTx } as unknown as TenantContextService;
}

describe('WebhookDedupService', () => {
  it('records a new (tenantId, bspMessageId) pair as not a duplicate', async () => {
    const withTenantTx = jest.fn().mockResolvedValue(undefined);
    const service = new WebhookDedupService(makeTenantContext(withTenantTx));

    await expect(
      service.checkAndRecord('tenant-a', 'wamid.123'),
    ).resolves.toEqual({ isDuplicate: false });
  });

  it('treats a Postgres unique-violation (23505) as a duplicate, not an error', async () => {
    const uniqueViolation = Object.assign(new Error('insert failed'), {
      cause: { code: '23505' },
    });
    const withTenantTx = jest.fn().mockRejectedValue(uniqueViolation);
    const service = new WebhookDedupService(makeTenantContext(withTenantTx));

    await expect(
      service.checkAndRecord('tenant-a', 'wamid.123'),
    ).resolves.toEqual({ isDuplicate: true });
  });

  it('re-throws any other database error unchanged', async () => {
    const otherError = Object.assign(new Error('connection reset'), {
      cause: { code: '08006' },
    });
    const withTenantTx = jest.fn().mockRejectedValue(otherError);
    const service = new WebhookDedupService(makeTenantContext(withTenantTx));

    await expect(service.checkAndRecord('tenant-a', 'wamid.123')).rejects.toBe(
      otherError,
    );
  });

  it('scopes the write to the resolved tenant via withTenantTx, not a bare insert', async () => {
    const withTenantTx = jest.fn().mockResolvedValue(undefined);
    const service = new WebhookDedupService(makeTenantContext(withTenantTx));

    await service.checkAndRecord('tenant-a', 'wamid.123');

    expect(withTenantTx).toHaveBeenCalledWith(expect.any(Function), 'tenant-a');
  });
});
