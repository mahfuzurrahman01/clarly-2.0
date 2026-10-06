import type { AppLoggerService } from '../core';
import type { TenantContextService } from '../tenant-context/tenant-context.service';
import { AgentConfigService } from './agent-config.service';

const TENANT_A = 'tenant-a';
const PHONE_NUMBER_ID = 'pn-1';
const NUMBER_ROW_ID = 'number-row-1';

/** Calls through to the real withTenantTx() callback against a fake tx matching this service's chains — same rationale as the other ConversationModule specs. */
function makeTenantContext(responses: unknown[]): {
  tenantContext: TenantContextService;
  withTenantTx: jest.Mock;
} {
  let call = 0;
  const withTenantTx = jest.fn((fn: (tx: unknown) => unknown) => {
    // Missing entries default to an empty result set: the document-scope
    // lookup runs on every resolve and would otherwise have to be queued in
    // every fixture just to say "no scoping".
    const response = responses[call++] ?? [];
    const terminal = {
      then: (resolve: (value: unknown) => void) => resolve(response),
      limit: () => Promise.resolve(response),
    };
    const tx = {
      select: () => ({
        from: () => ({
          innerJoin: () => ({ where: () => terminal }),
          where: () => terminal,
        }),
      }),
    };
    return fn(tx);
  });

  return {
    tenantContext: { withTenantTx } as unknown as TenantContextService,
    withTenantTx,
  };
}

function makeService(responses: unknown[]): {
  service: AgentConfigService;
  warn: jest.Mock;
} {
  const warn = jest.fn();
  const { tenantContext } = makeTenantContext(responses);
  return {
    service: new AgentConfigService(tenantContext, {
      warn,
    } as unknown as AppLoggerService),
    warn,
  };
}

function agentRow(overrides: Record<string, unknown> = {}) {
  return {
    id: 'agent-1',
    name: 'Default agent',
    whatsappNumberId: NUMBER_ROW_ID,
    configVersion: 3,
    persona: 'Warm and brief.',
    forbiddenTopics: ['legal advice'],
    confidenceThreshold: 0.42,
    rerankEnabled: false,
    handoverAutoReturnMinutes: 30,
    maxToolCallsPerTurn: 2,
    businessHours: null,
    timezone: null,
    outOfHoursResponse: null,
    intakeFields: [],
    ...overrides,
  };
}

describe('AgentConfigService.resolveForPhoneNumber()', () => {
  it('resolves the published agent bound to the number the message arrived on', async () => {
    const { service } = makeService([
      [agentRow(), agentRow({ id: 'agent-2', whatsappNumberId: 'other' })],
      [{ id: NUMBER_ROW_ID }],
    ]);

    await expect(
      service.resolveForPhoneNumber(TENANT_A, PHONE_NUMBER_ID),
    ).resolves.toMatchObject({
      agentId: 'agent-1',
      name: 'Default agent',
      configVersion: 3,
      resolvedBy: 'number',
    });
  });

  it('carries the published configuration the turn must run with, not just identity', async () => {
    // agents -> number lookup -> document scope, in the order the service
    // queries them.
    const { service } = makeService([
      [agentRow()],
      [{ id: NUMBER_ROW_ID }],
      [{ kbDocumentId: 'doc-1' }],
    ]);

    const resolved = await service.resolveForPhoneNumber(
      TENANT_A,
      PHONE_NUMBER_ID,
    );

    expect(resolved?.config).toEqual({
      persona: 'Warm and brief.',
      forbiddenTopics: ['legal advice'],
      confidenceThreshold: 0.42,
      rerankEnabled: false,
      handoverAutoReturnMinutes: 30,
      maxToolCallsPerTurn: 2,
      kbDocumentIds: ['doc-1'],
      businessHours: null,
      timezone: null,
      outOfHoursResponse: null,
      intakeFields: [],
    });
  });

  it("falls back to the tenant's only published agent when no agent is bound to the number", async () => {
    // F9's backfill binds a number only when the tenant had exactly one, so
    // an unbound single agent is the normal state, not an error.
    const { service } = makeService([
      [agentRow({ whatsappNumberId: null })],
      [{ id: NUMBER_ROW_ID }],
    ]);

    const resolved = await service.resolveForPhoneNumber(
      TENANT_A,
      PHONE_NUMBER_ID,
    );

    expect(resolved).toMatchObject({
      agentId: 'agent-1',
      resolvedBy: 'tenant_fallback',
    });
  });

  it('falls back for a pre-cutover job that carries no phone number at all', async () => {
    const { service, warn } = makeService([
      [agentRow({ whatsappNumberId: null })],
    ]);

    const resolved = await service.resolveForPhoneNumber(TENANT_A, null);

    expect(resolved).toMatchObject({ resolvedBy: 'tenant_fallback' });
    expect(warn).not.toHaveBeenCalled();
  });

  it('refuses to guess between several published agents — a wrong attribution is worse than none', async () => {
    const { service, warn } = makeService([
      [
        agentRow({ id: 'agent-1', whatsappNumberId: 'other-1' }),
        agentRow({ id: 'agent-2', whatsappNumberId: 'other-2' }),
      ],
      [{ id: NUMBER_ROW_ID }],
    ]);

    await expect(
      service.resolveForPhoneNumber(TENANT_A, PHONE_NUMBER_ID),
    ).resolves.toBeNull();
    expect(warn).toHaveBeenCalled();
  });

  it('returns null and warns when the tenant has no published agent, rather than throwing and losing the turn', async () => {
    const { service, warn } = makeService([[]]);

    await expect(
      service.resolveForPhoneNumber(TENANT_A, PHONE_NUMBER_ID),
    ).resolves.toBeNull();
    expect(warn).toHaveBeenCalled();
  });

  it('ignores an unbound number row and still resolves the single agent', async () => {
    const { service } = makeService([
      [agentRow({ whatsappNumberId: NUMBER_ROW_ID })],
      // The number is not in this tenant (or was deleted) — no row comes back.
      [],
    ]);

    await expect(
      service.resolveForPhoneNumber(TENANT_A, PHONE_NUMBER_ID),
    ).resolves.toMatchObject({ resolvedBy: 'tenant_fallback' });
  });

  it('reads through withTenantTx so RLS applies — never an admin query', async () => {
    const { tenantContext, withTenantTx } = makeTenantContext([
      [agentRow()],
      [{ id: NUMBER_ROW_ID }],
    ]);
    const service = new AgentConfigService(tenantContext, {
      warn: jest.fn(),
    } as unknown as AppLoggerService);

    await service.resolveForPhoneNumber(TENANT_A, PHONE_NUMBER_ID);

    expect(withTenantTx).toHaveBeenCalledWith(expect.any(Function), TENANT_A);
  });
});
