import type { TenantContextService } from '../tenant-context/tenant-context.service';
import { PartitionLifecycleService } from './partition-lifecycle.service';

const TENANT_A = '11111111-1111-1111-1111-111111111111';

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

/** Flattens a drizzle `sql` template into its static text plus bound params. */
function renderSql(
  execute: jest.Mock,
  call = 0,
): {
  text: string;
  params: unknown[];
} {
  const [sqlArg] = execute.mock.calls[call] as [{ queryChunks: unknown[] }];
  const text = sqlArg.queryChunks
    .map((chunk) =>
      chunk && typeof chunk === 'object' && 'value' in chunk
        ? ((chunk as { value: string[] }).value ?? []).join('')
        : '',
    )
    .join('?');
  const params = sqlArg.queryChunks.filter(
    (chunk) => !(chunk && typeof chunk === 'object' && 'value' in chunk),
  );
  return { text, params };
}

// The DDL itself lives in migration 0064's SECURITY DEFINER functions: the API
// connects as `app_user`, which does not own `kb_chunks`, and both
// `CREATE TABLE ... PARTITION OF` and `DROP TABLE` require ownership (42501,
// found by the L2 eval on 2026-09-28). The function is also where the
// partition's RLS policy is created — see the migration.
describe('PartitionLifecycleService.ensurePartitionForTenant()', () => {
  it('calls public.ensure_kb_partition() with the tenant id as a bound parameter, inside the tenant tx', async () => {
    const { tenantContext, execute, withTenantTx } = makeTenantContext();
    const service = new PartitionLifecycleService(tenantContext);

    await service.ensurePartitionForTenant(TENANT_A);

    expect(withTenantTx).toHaveBeenCalledWith(expect.any(Function), TENANT_A);
    expect(execute).toHaveBeenCalledTimes(1);
    const { text, params } = renderSql(execute);
    expect(text).toContain('public.ensure_kb_partition(');
    expect(text).toContain('::uuid');
    expect(text).not.toContain('PARTITION OF');
    expect(params).toEqual([TENANT_A]);
  });

  it('rejects a tenantId that is not a valid UUID, without touching the database', async () => {
    const { tenantContext, execute } = makeTenantContext();
    const service = new PartitionLifecycleService(tenantContext);

    await expect(
      service.ensurePartitionForTenant("'; DROP TABLE kb_chunks; --"),
    ).rejects.toThrow(/not a valid UUID/);
    expect(execute).not.toHaveBeenCalled();
  });
});

describe('PartitionLifecycleService.dropPartitionForTenant()', () => {
  it('calls public.drop_kb_partition() with the tenant id as a bound parameter, inside the tenant tx', async () => {
    const { tenantContext, execute, withTenantTx } = makeTenantContext();
    const service = new PartitionLifecycleService(tenantContext);

    await service.dropPartitionForTenant(TENANT_A);

    expect(withTenantTx).toHaveBeenCalledWith(expect.any(Function), TENANT_A);
    expect(execute).toHaveBeenCalledTimes(1);
    const { text, params } = renderSql(execute);
    expect(text).toContain('public.drop_kb_partition(');
    expect(text).not.toContain('DROP TABLE');
    expect(params).toEqual([TENANT_A]);
  });

  it('rejects a tenantId that is not a valid UUID, without touching the database', async () => {
    const { tenantContext, execute } = makeTenantContext();
    const service = new PartitionLifecycleService(tenantContext);

    await expect(service.dropPartitionForTenant('not-a-uuid')).rejects.toThrow(
      /not a valid UUID/,
    );
    expect(execute).not.toHaveBeenCalled();
  });
});
