import type { AppConfigService, AppLoggerService } from '../core';
import type { TenantContextService } from '../tenant-context/tenant-context.service';
import { AgentRunService } from './agent-run.service';
import type { RecordAgentRunInput } from './agent-run.dto';

function makeInput(
  overrides: Partial<RecordAgentRunInput> = {},
): RecordAgentRunInput {
  return {
    tenantId: 'tenant-a',
    conversationId: 'conv-1',
    ticketId: null,
    status: 'success',
    escalationReason: null,
    escalationSource: null,
    escalationDetail: null,
    agentId: null,
    agentConfigVersion: null,
    confidence: 0.9,
    inputTokens: 100,
    outputTokens: 20,
    latencyMs: 250,
    spans: { retrievalMs: 30, llmMs: 200 },
    promptVersion: 'v1',
    errorMessage: null,
    ...overrides,
  };
}

/** Returns the mock fns alongside the logger — asserting on `logger.warn` directly trips @typescript-eslint/unbound-method. */
function makeLogger(): { logger: AppLoggerService; warn: jest.Mock } {
  const warn = jest.fn();
  const logger = {
    log: jest.fn(),
    warn,
    error: jest.fn(),
  } as unknown as AppLoggerService;
  return { logger, warn };
}

describe('AgentRunService.recordRun()', () => {
  it('inserts one agent_runs row scoped to the tenant, with cost computed from the configured model', async () => {
    let insertedValues: Record<string, unknown> | undefined;
    const withTenantTx = jest.fn((fn: (tx: unknown) => unknown) =>
      fn({
        insert: () => ({
          values: (values: Record<string, unknown>) => {
            insertedValues = values;
            return Promise.resolve(undefined);
          },
        }),
      }),
    );
    const tenantContext = { withTenantTx } as unknown as TenantContextService;
    const config = { llmModel: 'gemini-3.5-flash-lite' } as AppConfigService;
    const service = new AgentRunService(
      tenantContext,
      config,
      makeLogger().logger,
    );

    await service.recordRun(makeInput());

    expect(withTenantTx).toHaveBeenCalledWith(expect.any(Function), 'tenant-a');
    expect(insertedValues).toMatchObject({
      tenantId: 'tenant-a',
      conversationId: 'conv-1',
      ticketId: null,
      status: 'success',
      inputTokens: 100,
      outputTokens: 20,
      latencyMs: 250,
      spans: { retrievalMs: 30, llmMs: 200 },
      promptVersion: 'v1',
    });
    // 100 input tokens @ $0.30/1M + 20 output tokens @ $2.50/1M
    expect(insertedValues?.costUsd).toBeCloseTo(0.00008, 9);
  });

  it('persists escalationDetail verbatim, including the open-ended provider_error form', async () => {
    let insertedValues: Record<string, unknown> | undefined;
    const withTenantTx = jest.fn((fn: (tx: unknown) => unknown) =>
      fn({
        insert: () => ({
          values: (values: Record<string, unknown>) => {
            insertedValues = values;
            return Promise.resolve(undefined);
          },
        }),
      }),
    );
    const tenantContext = { withTenantTx } as unknown as TenantContextService;
    const config = { llmModel: 'gemini-3.5-flash-lite' } as AppConfigService;
    const service = new AgentRunService(
      tenantContext,
      config,
      makeLogger().logger,
    );

    await service.recordRun(
      makeInput({
        status: 'escalated',
        escalationReason: 'LLM_ERROR',
        escalationSource: 'error_forced',
        escalationDetail: 'provider_error:LLM_TIMEOUT',
      }),
    );

    expect(insertedValues).toMatchObject({
      escalationReason: 'LLM_ERROR',
      escalationDetail: 'provider_error:LLM_TIMEOUT',
    });
  });

  it('writes escalationDetail as null (never a placeholder) for a run that took no forced-escalation branch', async () => {
    let insertedValues: Record<string, unknown> | undefined;
    const withTenantTx = jest.fn((fn: (tx: unknown) => unknown) =>
      fn({
        insert: () => ({
          values: (values: Record<string, unknown>) => {
            insertedValues = values;
            return Promise.resolve(undefined);
          },
        }),
      }),
    );
    const tenantContext = { withTenantTx } as unknown as TenantContextService;
    const config = { llmModel: 'gemini-3.5-flash-lite' } as AppConfigService;
    const service = new AgentRunService(
      tenantContext,
      config,
      makeLogger().logger,
    );

    await service.recordRun(makeInput());

    expect(insertedValues).toHaveProperty('escalationDetail', null);
  });

  it('computes 0 cost for a model with no sourced pricing', async () => {
    let insertedValues: Record<string, unknown> | undefined;
    const withTenantTx = jest.fn((fn: (tx: unknown) => unknown) =>
      fn({
        insert: () => ({
          values: (values: Record<string, unknown>) => {
            insertedValues = values;
            return Promise.resolve(undefined);
          },
        }),
      }),
    );
    const tenantContext = { withTenantTx } as unknown as TenantContextService;
    const config = { llmModel: 'unknown-model' } as AppConfigService;
    const service = new AgentRunService(
      tenantContext,
      config,
      makeLogger().logger,
    );

    await service.recordRun(makeInput());

    expect(insertedValues?.costUsd).toBe(0);
  });

  // The 0 above is correct but was previously indistinguishable from "this
  // run really was free" — and LLM_MODEL has already outrun the pricing table
  // once (Gemini -> Qwen), zeroing A8's cost accounting for every production
  // run without a single signal.
  it('warns once per process about an unpriced model rather than zeroing cost silently', async () => {
    const withTenantTx = jest.fn((fn: (tx: unknown) => unknown) =>
      fn({ insert: () => ({ values: () => Promise.resolve(undefined) }) }),
    );
    const tenantContext = { withTenantTx } as unknown as TenantContextService;
    const config = { llmModel: 'unknown-model' } as AppConfigService;
    const { logger, warn } = makeLogger();
    const service = new AgentRunService(tenantContext, config, logger);

    await service.recordRun(makeInput());
    await service.recordRun(makeInput());

    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn).toHaveBeenCalledWith(
      expect.stringContaining('unknown-model'),
      'AgentRunService',
    );
  });

  it('stays quiet for a model the pricing table knows', async () => {
    const withTenantTx = jest.fn((fn: (tx: unknown) => unknown) =>
      fn({ insert: () => ({ values: () => Promise.resolve(undefined) }) }),
    );
    const tenantContext = { withTenantTx } as unknown as TenantContextService;
    const config = { llmModel: 'gemini-3.5-flash-lite' } as AppConfigService;
    const { logger, warn } = makeLogger();
    const service = new AgentRunService(tenantContext, config, logger);

    await service.recordRun(makeInput());

    expect(warn).not.toHaveBeenCalled();
  });
});
