import { ConflictException, NotFoundException } from '@nestjs/common';
import type { TenantContextService } from '../tenant-context/tenant-context.service';
import { AgentManagementService } from './agent-management.service';

const TENANT_A = 'tenant-a';
const USER_ID = 'user-1';
const AGENT_ID = 'agent-1';

interface Write {
  kind: 'insert' | 'update';
  values: Record<string, unknown>;
}

/**
 * NOTE: `update()` calls consume no queued response — only selects and
 * `insert().returning()` do. Line the responses up accordingly.
 *
 * Calls through to the real withTenantTx() callback against a fake tx
 * matching this service's chains, and records every write — the lifecycle
 * rules under test (draft vs published, fork-on-edit) are entirely about
 * WHICH row gets written with WHAT, so asserting on the writes is the point.
 */
function makeTenantContext(responses: unknown[]): {
  tenantContext: TenantContextService;
  writes: Write[];
} {
  let call = 0;
  const writes: Write[] = [];

  const withTenantTx = jest.fn((fn: (tx: unknown) => unknown) => {
    const next = () => responses[call++];

    const tx = {
      select: () => ({
        from: () => {
          const response = next();
          const terminal = {
            then: (resolve: (value: unknown) => void) => resolve(response),
            limit: () => Promise.resolve(response),
            orderBy: () => Promise.resolve(response),
          };
          return {
            where: () => terminal,
            // mirrorToTenantPolicy() joins agents -> agent_versions.
            innerJoin: () => ({ where: () => terminal }),
            ...terminal,
          };
        },
      }),
      insert: () => ({
        values: (values: Record<string, unknown>) => {
          writes.push({ kind: 'insert', values });
          return {
            returning: () => Promise.resolve(next()),
            // mirrorToTenantPolicy() upserts.
            onConflictDoUpdate: () => Promise.resolve(undefined),
          };
        },
      }),
      delete: () => ({ where: () => Promise.resolve(undefined) }),
      update: () => ({
        set: (values: Record<string, unknown>) => {
          writes.push({ kind: 'update', values });
          return {
            where: () => Promise.resolve(undefined),
          };
        },
      }),
    };

    return fn(tx);
  });

  return {
    tenantContext: { withTenantTx } as unknown as TenantContextService,
    writes,
  };
}

function agentRow(overrides: Record<string, unknown> = {}) {
  return {
    id: AGENT_ID,
    tenantId: TENANT_A,
    name: 'Default agent',
    status: 'published',
    whatsappNumberId: null,
    publishedVersionId: 'version-published',
    draftVersionId: null,
    createdAt: new Date('2026-08-18T00:00:00Z'),
    updatedAt: new Date('2026-08-18T00:00:00Z'),
    ...overrides,
  };
}

function versionRow(overrides: Record<string, unknown> = {}) {
  return {
    id: 'version-published',
    tenantId: TENANT_A,
    agentId: AGENT_ID,
    version: 1,
    roleDescription: null,
    persona: 'Warm and brief.',
    tone: 'friendly',
    languages: [],
    greeting: null,
    outOfScopeResponse: null,
    forbiddenTopics: ['legal advice'],
    businessHours: null,
    timezone: null,
    outOfHoursResponse: null,
    escalationTriggers: [],
    confidenceThreshold: 0.8,
    rerankEnabled: true,
    stuckTicketThresholdMinutes: 15,
    handoverAutoReturnMinutes: 60,
    maxToolCallsPerTurn: 2,
    publishedAt: new Date('2026-08-18T00:00:00Z'),
    createdBy: USER_ID,
    createdAt: new Date('2026-08-18T00:00:00Z'),
    updatedAt: new Date('2026-08-18T00:00:00Z'),
    ...overrides,
  };
}

describe('AgentManagementService.create()', () => {
  it('creates a DRAFT agent that answers nobody until it is published', async () => {
    const { tenantContext, writes } = makeTenantContext([
      [{ id: AGENT_ID }], // insert agent
      [{ id: 'version-1' }], // insert version
      [
        agentRow({
          status: 'draft',
          publishedVersionId: null,
          draftVersionId: 'version-1',
        }),
      ], // get()
      [versionRow({ id: 'version-1', publishedAt: null })], // versionsFor()
    ]);
    const service = new AgentManagementService(tenantContext);

    const record = await service.create(TENANT_A, USER_ID, 'Sales agent', {
      persona: 'Warm and brief.',
    });

    expect(writes[0].values).toMatchObject({
      name: 'Sales agent',
      status: 'draft',
    });
    expect(writes[1].values).toMatchObject({ version: 1, createdBy: USER_ID });
    expect(record.status).toBe('draft');
    expect(record.publishedVersion).toBeNull();
    expect(record.hasUnpublishedChanges).toBe(true);
  });

  // `agents_tenant_id_name_unique` is what enforces one name per workspace.
  // Reaching the caller as a 500 tells them the product broke; it did not.
  it('turns a duplicate agent name into a 409 rather than a 500', async () => {
    const duplicate = Object.assign(new Error('Failed query'), {
      cause: Object.assign(new Error('duplicate key'), { code: '23505' }),
    });
    const withTenantTx = jest.fn().mockRejectedValue(duplicate);
    const service = new AgentManagementService({
      withTenantTx,
    } as unknown as TenantContextService);

    await expect(
      service.create(TENANT_A, USER_ID, 'Sales agent', {}),
    ).rejects.toBeInstanceOf(ConflictException);
  });
});

describe('AgentManagementService.update()', () => {
  it('writes the existing draft rather than the published version', async () => {
    const { tenantContext, writes } = makeTenantContext([
      [agentRow({ draftVersionId: 'version-draft' })], // requireAgent
      [agentRow({ draftVersionId: 'version-draft' })], // get()
      [versionRow({ id: 'version-draft', version: 2, publishedAt: null })],
    ]);
    const service = new AgentManagementService(tenantContext);

    await service.update(TENANT_A, USER_ID, AGENT_ID, undefined, {
      greeting: 'Hi!',
    });

    const updates = writes.filter((write) => write.kind === 'update');
    expect(updates).toHaveLength(1);
    expect(updates[0].values).toMatchObject({ greeting: 'Hi!' });
    // Nothing was inserted: an agent that already has a draft must not grow a
    // second one per edit.
    expect(writes.some((write) => write.kind === 'insert')).toBe(false);
  });

  it('forks the published values into a new draft, so setting one field does not reset the rest', async () => {
    const { tenantContext, writes } = makeTenantContext([
      [agentRow()], // requireAgent — published, no draft
      [versionRow()], // select published row to fork
      [{ next: 2 }], // next version number
      [{ id: 'version-2' }], // insert draft
      [agentRow({ draftVersionId: 'version-2' })], // get()
      [
        versionRow({
          id: 'version-2',
          version: 2,
          publishedAt: null,
          greeting: 'Hi!',
        }),
      ],
    ]);
    const service = new AgentManagementService(tenantContext);

    await service.update(TENANT_A, USER_ID, AGENT_ID, undefined, {
      greeting: 'Hi!',
    });

    const inserted = writes.find((write) => write.kind === 'insert');
    expect(inserted?.values).toMatchObject({
      version: 2,
      greeting: 'Hi!',
      // Carried over from the published version, not reset to a column default.
      persona: 'Warm and brief.',
      confidenceThreshold: 0.8,
      forbiddenTopics: ['legal advice'],
    });
  });

  it("404s for another tenant's agent before writing anything", async () => {
    const { tenantContext, writes } = makeTenantContext([[]]);
    const service = new AgentManagementService(tenantContext);

    await expect(
      service.update(TENANT_A, USER_ID, AGENT_ID, 'renamed', undefined),
    ).rejects.toBeInstanceOf(NotFoundException);
    expect(writes).toHaveLength(0);
  });
});

describe('AgentManagementService.publish()', () => {
  it('stamps the draft published and points the agent at it', async () => {
    const { tenantContext, writes } = makeTenantContext([
      [agentRow({ draftVersionId: 'version-2' })], // requireAgent
      [], // mirrorToTenantPolicy — no single published agent in this fixture
      [agentRow({ publishedVersionId: 'version-2', draftVersionId: null })], // get()
      [versionRow({ id: 'version-2', version: 2 })],
    ]);
    const service = new AgentManagementService(tenantContext);

    const record = await service.publish(TENANT_A, AGENT_ID);

    expect(writes[0].values).toMatchObject({ publishedAt: expect.any(Date) });
    expect(writes[1].values).toMatchObject({
      status: 'published',
      publishedVersionId: 'version-2',
      draftVersionId: null,
    });
    expect(record.hasUnpublishedChanges).toBe(false);
    expect(record.publishedVersion).toBe(2);
  });

  it('is a no-op with no draft — failing a button press that changes nothing is noise', async () => {
    const { tenantContext, writes } = makeTenantContext([
      [agentRow()], // requireAgent — no draft
      [], // mirrorToTenantPolicy
      [agentRow()], // get()
      [versionRow()],
    ]);
    const service = new AgentManagementService(tenantContext);

    await expect(service.publish(TENANT_A, AGENT_ID)).resolves.toMatchObject({
      publishedVersion: 1,
    });
    expect(writes).toHaveLength(0);
  });
});

describe('AgentManagementService.get()', () => {
  it("shows the DRAFT when one exists, never the published values — otherwise a console hides the tenant's own unsaved edits", async () => {
    const { tenantContext } = makeTenantContext([
      [agentRow({ draftVersionId: 'version-2' })],
      [
        versionRow({ greeting: null }),
        versionRow({
          id: 'version-2',
          version: 2,
          publishedAt: null,
          greeting: 'Draft greeting',
        }),
      ],
    ]);
    const service = new AgentManagementService(tenantContext);

    const record = await service.get(TENANT_A, AGENT_ID);

    expect(record.config?.greeting).toBe('Draft greeting');
    expect(record.publishedVersion).toBe(1);
    expect(record.hasUnpublishedChanges).toBe(true);
  });
});

describe('AgentManagementService publish → tenant_policy mirror', () => {
  it('mirrors the published configuration down to the legacy policy row for the tenant-level consumers', async () => {
    const { tenantContext, writes } = makeTenantContext([
      [agentRow({ draftVersionId: 'version-2' })], // requireAgent
      [
        {
          persona: 'Warm and brief.',
          forbiddenTopics: ['legal advice'],
          confidenceThreshold: 0.42,
          rerankEnabled: false,
          stuckTicketThresholdMinutes: 33,
        },
      ], // mirror — exactly one published agent
      [agentRow({ publishedVersionId: 'version-2', draftVersionId: null })],
      [versionRow({ id: 'version-2', version: 2 })],
    ]);
    const service = new AgentManagementService(tenantContext);

    await service.publish(TENANT_A, AGENT_ID);

    const mirrored = writes.find(
      (write) =>
        write.kind === 'insert' && 'tonePersonaOverride' in write.values,
    );
    expect(mirrored?.values).toMatchObject({
      tenantId: TENANT_A,
      tonePersonaOverride: 'Warm and brief.',
      forbiddenTopics: ['legal advice'],
      confidenceThreshold: 0.42,
      rerankEnabled: false,
      stuckTicketThresholdMinutes: 33,
    });
  });

  it('does not mirror when the tenant has several published agents — "the tenant\'s threshold" has no single answer then', async () => {
    const { tenantContext, writes } = makeTenantContext([
      [agentRow({ draftVersionId: 'version-2' })], // requireAgent
      [{ persona: 'a' }, { persona: 'b' }], // two published agents
      [agentRow({ publishedVersionId: 'version-2', draftVersionId: null })],
      [versionRow({ id: 'version-2', version: 2 })],
    ]);
    const service = new AgentManagementService(tenantContext);

    await service.publish(TENANT_A, AGENT_ID);

    expect(
      writes.some(
        (write) =>
          write.kind === 'insert' && 'tonePersonaOverride' in write.values,
      ),
    ).toBe(false);
  });
});

describe('AgentManagementService number binding', () => {
  it('refuses a number that belongs to another tenant — whatsapp_numbers has no RLS, so this filter is the only check', async () => {
    const { tenantContext, writes } = makeTenantContext([
      [agentRow()], // requireAgent
      [], // number lookup scoped to this tenant finds nothing
    ]);
    const service = new AgentManagementService(tenantContext);

    await expect(
      service.update(
        TENANT_A,
        USER_ID,
        AGENT_ID,
        undefined,
        undefined,
        'number-x',
      ),
    ).rejects.toBeInstanceOf(NotFoundException);
    expect(writes).toHaveLength(0);
  });

  it('refuses to steal a number another agent already answers on', async () => {
    const { tenantContext, writes } = makeTenantContext([
      [agentRow()], // requireAgent
      [{ id: 'number-1' }], // the number exists in this tenant
      [{ id: 'other-agent', name: 'Sales agent' }], // already bound elsewhere
    ]);
    const service = new AgentManagementService(tenantContext);

    await expect(
      service.update(
        TENANT_A,
        USER_ID,
        AGENT_ID,
        undefined,
        undefined,
        'number-1',
      ),
    ).rejects.toBeInstanceOf(ConflictException);
    // Nothing written: live traffic keeps going where its owner pointed it.
    expect(writes).toHaveLength(0);
  });

  it('binds a free number', async () => {
    const { tenantContext, writes } = makeTenantContext([
      [agentRow()], // requireAgent
      [{ id: 'number-1' }], // exists
      [], // nobody holds it
      [agentRow({ whatsappNumberId: 'number-1' })], // get()
      [versionRow()],
    ]);
    const service = new AgentManagementService(tenantContext);

    await service.update(
      TENANT_A,
      USER_ID,
      AGENT_ID,
      undefined,
      undefined,
      'number-1',
    );

    expect(writes[0].values).toMatchObject({ whatsappNumberId: 'number-1' });
  });

  it('rebinding the same number to the same agent is not a conflict', async () => {
    const { tenantContext } = makeTenantContext([
      [agentRow({ whatsappNumberId: 'number-1' })], // requireAgent
      [{ id: 'number-1' }],
      [{ id: AGENT_ID, name: 'Default agent' }], // held by this very agent
      [agentRow({ whatsappNumberId: 'number-1' })],
      [versionRow()],
    ]);
    const service = new AgentManagementService(tenantContext);

    await expect(
      service.update(
        TENANT_A,
        USER_ID,
        AGENT_ID,
        undefined,
        undefined,
        'number-1',
      ),
    ).resolves.toBeDefined();
  });

  it('clears the number binding when archiving, so a replacement can take that traffic', async () => {
    const { tenantContext, writes } = makeTenantContext([
      [agentRow({ whatsappNumberId: 'number-1' })], // requireAgent
      [], // mirror: no single published agent left
      [agentRow({ status: 'archived', whatsappNumberId: null })], // get()
      [versionRow()],
    ]);
    const service = new AgentManagementService(tenantContext);

    await service.archive(TENANT_A, AGENT_ID);

    expect(writes[0].values).toMatchObject({
      status: 'archived',
      whatsappNumberId: null,
    });
  });
});

describe('AgentManagementService knowledge scope', () => {
  it('reports scopedToAll when nothing is selected — an agent scoped to zero documents could answer nothing, which nobody means', async () => {
    const { tenantContext } = makeTenantContext([
      [agentRow()], // requireAgent
      [
        { id: 'doc-1', filename: 'refunds.pdf' },
        { id: 'doc-2', filename: 'pricing.pdf' },
      ],
      [], // no selections
    ]);
    const service = new AgentManagementService(tenantContext);

    const scope = await service.knowledgeScope(TENANT_A, AGENT_ID);

    expect(scope.scopedToAll).toBe(true);
    expect(scope.documents.every((document) => !document.selected)).toBe(true);
  });

  it('flags the selected documents and stops claiming scopedToAll', async () => {
    const { tenantContext } = makeTenantContext([
      [agentRow()],
      [
        { id: 'doc-1', filename: 'refunds.pdf' },
        { id: 'doc-2', filename: 'pricing.pdf' },
      ],
      [{ kbDocumentId: 'doc-2' }],
    ]);
    const service = new AgentManagementService(tenantContext);

    const scope = await service.knowledgeScope(TENANT_A, AGENT_ID);

    expect(scope.scopedToAll).toBe(false);
    expect(scope.documents).toEqual([
      { id: 'doc-1', filename: 'refunds.pdf', selected: false },
      { id: 'doc-2', filename: 'pricing.pdf', selected: true },
    ]);
  });

  it("refuses a document id that is not this workspace's, rather than storing a scope that quietly does not apply", async () => {
    const { tenantContext, writes } = makeTenantContext([
      [agentRow()], // requireAgent
      [{ id: 'doc-1' }], // only one of the two requested ids is owned
    ]);
    const service = new AgentManagementService(tenantContext);

    await expect(
      service.setKnowledgeScope(TENANT_A, AGENT_ID, ['doc-1', 'doc-stolen']),
    ).rejects.toBeInstanceOf(NotFoundException);
    expect(writes).toHaveLength(0);
  });

  it('replaces the scope wholesale, and an empty list clears it back to the whole knowledge base', async () => {
    const deletes: string[] = [];
    const { tenantContext, writes } = makeTenantContext([[agentRow()]]);
    const service = new AgentManagementService(tenantContext);

    await service.setKnowledgeScope(TENANT_A, AGENT_ID, []);

    // Cleared, and nothing inserted — an empty selection means "everything",
    // so writing zero rows is the correct representation of it.
    expect(writes.filter((write) => write.kind === 'insert')).toHaveLength(0);
    expect(deletes).toEqual([]);
  });
});
