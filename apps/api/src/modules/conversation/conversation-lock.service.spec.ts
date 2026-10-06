import type { TenantContextService } from '../tenant-context/tenant-context.service';
import { ConversationLockService } from './conversation-lock.service';

const TENANT_A = 'tenant-a';

function makeTenantContext(): {
  tenantContext: TenantContextService;
  withTenantTx: jest.Mock;
  execute: jest.Mock;
} {
  const execute = jest.fn().mockResolvedValue(undefined);
  const withTenantTx = jest.fn((fn: (tx: { execute: jest.Mock }) => unknown) =>
    fn({ execute }),
  );
  return {
    tenantContext: { withTenantTx } as unknown as TenantContextService,
    withTenantTx,
    execute,
  };
}

describe('ConversationLockService.withLock()', () => {
  it('acquires the transaction-scoped advisory lock before running fn(), scoped to the given tenant', async () => {
    const { tenantContext, withTenantTx, execute } = makeTenantContext();
    const service = new ConversationLockService(tenantContext);
    const fn = jest.fn().mockResolvedValue('result');

    const result = await service.withLock(TENANT_A, 'tenant-a:15551234567', fn);

    expect(result).toBe('result');
    expect(withTenantTx).toHaveBeenCalledWith(expect.any(Function), TENANT_A);
    expect(execute).toHaveBeenCalledTimes(1);
    const [sqlArg] = execute.mock.calls[0] as [
      { queryChunks: Array<{ value?: string[] } | string> },
    ];
    const rendered = sqlArg.queryChunks
      .map((chunk) =>
        typeof chunk === 'string' ? chunk : (chunk.value?.[0] ?? ''),
      )
      .join('');
    expect(rendered).toContain('pg_advisory_xact_lock');
    expect(fn).toHaveBeenCalled();
  });

  it("propagates fn()'s return value and errors unchanged", async () => {
    const { tenantContext } = makeTenantContext();
    const service = new ConversationLockService(tenantContext);

    await expect(
      service.withLock(TENANT_A, 'key', () =>
        Promise.reject(new Error('boom')),
      ),
    ).rejects.toThrow('boom');
  });
});
