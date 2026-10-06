import type { TenantContextService } from '../tenant-context/tenant-context.service';
import {
  KnowledgeGapService,
  KNOWLEDGE_GAP_REASONS,
} from './knowledge-gap.service';

const TENANT_A = 'tenant-a';
const RANGE = {
  from: new Date('2026-08-11T00:00:00Z'),
  to: new Date('2026-08-18T00:00:00Z'),
};

function makeTenantContext(responses: unknown[]) {
  let call = 0;
  const withTenantTx = jest.fn((fn: (tx: unknown) => unknown) => {
    const response = responses[call++] ?? [];
    const terminal = {
      then: (resolve: (value: unknown) => void) => resolve(response),
      limit: () => Promise.resolve(response),
      orderBy: () => ({ limit: () => Promise.resolve(response) }),
      groupBy: () => Promise.resolve(response),
    };
    const tx = {
      select: () => ({ from: () => ({ where: () => terminal }) }),
      // The gap query is executed as one statement (correlated subquery).
      execute: () => Promise.resolve({ rows: response }),
    };
    return fn(tx);
  });
  return { tenantContext: { withTenantTx } as unknown as TenantContextService };
}

describe('KnowledgeGapService.getReport()', () => {
  it('returns the customer questions behind content-shaped escalations, with per-reason totals', async () => {
    const { tenantContext } = makeTenantContext([
      [
        {
          reason: 'KB_NOT_INDEXED',
          occurred_at: '2026-08-17T10:00:00.000Z',
          conversation_id: 'conv-1',
          question: 'do you deliver to Sylhet?',
        },
      ],
      [
        { reason: 'KB_NOT_INDEXED', count: 4 },
        { reason: 'KB_CONFLICT', count: 1 },
      ],
    ]);
    const service = new KnowledgeGapService(tenantContext);

    const report = await service.getReport(TENANT_A, RANGE, 50);

    expect(report.gaps).toEqual([
      {
        reason: 'KB_NOT_INDEXED',
        question: 'do you deliver to Sylhet?',
        occurredAt: new Date('2026-08-17T10:00:00Z'),
        conversationId: 'conv-1',
      },
    ]);
    expect(report.totals).toEqual([
      { reason: 'KB_NOT_INDEXED', count: 4 },
      { reason: 'KB_CONFLICT', count: 1 },
    ]);
  });

  it('keeps a gap whose question has been purged rather than dropping it and under-counting', async () => {
    const { tenantContext } = makeTenantContext([
      [
        {
          reason: 'CONFIDENCE_BELOW_THRESHOLD',
          occurred_at: '2026-05-01T10:00:00.000Z',
          conversation_id: null,
          question: null,
        },
      ],
      [{ reason: 'CONFIDENCE_BELOW_THRESHOLD', count: 1 }],
    ]);
    const service = new KnowledgeGapService(tenantContext);

    const report = await service.getReport(TENANT_A, RANGE, 50);

    expect(report.gaps).toHaveLength(1);
    expect(report.gaps[0].question).toBeNull();
  });

  it('covers only reasons a tenant can fix by writing a document', () => {
    // A tool or delivery failure is ours or the BSP's; listing it under
    // "write this documentation" sends a tenant to fix what they cannot.
    expect([...KNOWLEDGE_GAP_REASONS]).toEqual([
      'KB_NOT_INDEXED',
      'CONFIDENCE_BELOW_THRESHOLD',
      'KB_CONFLICT',
    ]);
    expect(KNOWLEDGE_GAP_REASONS).not.toContain('TOOL_FAILURE');
    expect(KNOWLEDGE_GAP_REASONS).not.toContain('DELIVERY_FAILURE');
  });
});
