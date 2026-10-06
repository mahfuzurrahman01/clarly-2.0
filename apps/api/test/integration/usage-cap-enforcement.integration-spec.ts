// Feature 8 exit criteria (T17/T20): "a tenant exceeding its configured
// cap gets a deterministic degrade (escalate-to-human, not silent LLM
// skip or unbounded spend)." Drives the REAL respond path end-to-end
// (RespondPathProducerService -> `respond-path` queue -> RespondPathProcessor
// -> UsageService.checkEntitlement() -> either AgentRuntime or the
// force-escalation shortcut) against real Postgres + Redis + BullMQ, with
// a real `tenant_subscriptions`/`plans` row and pre-seeded `agent_runs`
// usage already at the plan's message limit. `LlmProvider` is overridden
// with a call-counting fake specifically to prove the real assertion this
// test exists for: the LLM is never called once a tenant is over its cap
// — not just that the ticket/escalation-reason came out right.
//
// Requires real Postgres + Redis. Run via `npm run test:integration`.
import { randomUUID } from 'node:crypto';
import { Test, type TestingModule } from '@nestjs/testing';
import { eq } from 'drizzle-orm';
import { RESPOND_TOOL_NAME } from '../../src/modules/agent/respond-tool-definition';
import { CoreModule } from '../../src/modules/core/core.module';
import {
  LlmProvider,
  type LlmCompleteResult,
  type LlmToolResult,
} from '../../src/modules/llm/ports/llm-provider.port';
import { OnboardingModule } from '../../src/modules/onboarding/onboarding.module';
import { TenantPolicyService } from '../../src/modules/onboarding/tenant-policy.service';
import {
  agentRuns,
  plans,
  tenantSubscriptions,
  tenants,
} from '../../src/modules/persistence/drizzle/schema';
import { PersistenceModule } from '../../src/modules/persistence/persistence.module';
import { PersistenceService } from '../../src/modules/persistence/persistence.service';
import { TenantContextModule } from '../../src/modules/tenant-context/tenant-context.module';
import { TenantContextService } from '../../src/modules/tenant-context/tenant-context.service';
import { RespondPathProducerService } from '../../src/modules/webhook/respond-path-producer.service';
import { WebhookModule } from '../../src/modules/webhook/webhook.module';

/** Counts real calls so the test can assert the LLM was never reached — the actual point of T17's "deterministic degrade," not just that the ticket came out right. */
class CountingLlmProvider extends LlmProvider {
  callCount = 0;

  // eslint-disable-next-line @typescript-eslint/require-await -- no network call.
  async complete(): Promise<LlmCompleteResult> {
    throw new Error('not used in this integration test');
  }

  // eslint-disable-next-line @typescript-eslint/require-await -- no network call.
  async completeWithTools(): Promise<LlmToolResult> {
    this.callCount++;
    return {
      content: '',
      stopReason: 'end_turn',
      usage: { inputTokens: 10, outputTokens: 5 },
      toolCalls: [
        {
          id: `call-${randomUUID()}`,
          name: RESPOND_TOOL_NAME,
          input: {
            answer: 'Should never be reached.',
            cited_chunk_ids: [],
            confidence: 0.9,
            escalate: false,
          },
        },
      ],
    };
  }

  // eslint-disable-next-line @typescript-eslint/require-await -- no network call.
  async countTokens(): Promise<number> {
    return 0;
  }
}

// 25s of headroom rather than 10s. A turn here does not start when
// enqueue() returns: it starts as a DELAYED BullMQ job (T10's debounce) and
// is picked up whenever the worker next wakes. That wake is not bounded by
// the debounce, so a 10s budget was leaving very little margin on a loaded
// machine for something that is pure queue latency, not agent behaviour.
async function waitUntil(
  predicate: () => Promise<boolean>,
  timeoutMs = 25000,
): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (await predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error(`waitUntil() timed out after ${timeoutMs}ms`);
}

describe('Usage-cap enforcement (Feature 8 exit criteria, T17/T20)', () => {
  let moduleRef: TestingModule;
  let persistence: PersistenceService;
  let tenantContext: TenantContextService;
  let respondPathProducer: RespondPathProducerService;
  let llmProvider: CountingLlmProvider;

  const tenantId = randomUUID();
  const planId = randomUUID();
  const MESSAGE_LIMIT = 3;

  beforeAll(async () => {
    // Shrink T10's production-default debounce for the suite.
    process.env.BURST_COALESCE_DEBOUNCE_MS = '50';
    moduleRef = await Test.createTestingModule({
      imports: [
        CoreModule,
        PersistenceModule,
        TenantContextModule,
        WebhookModule,
        OnboardingModule,
      ],
    })
      .overrideProvider(LlmProvider)
      .useClass(CountingLlmProvider)
      .compile();

    await moduleRef.init();

    persistence = moduleRef.get(PersistenceService);
    tenantContext = moduleRef.get(TenantContextService);
    respondPathProducer = moduleRef.get(RespondPathProducerService);
    llmProvider = moduleRef.get(LlmProvider);
    const tenantPolicyService = moduleRef.get(TenantPolicyService);

    await persistence.runAdminQuery((db) =>
      db
        .insert(tenants)
        .values({ id: tenantId, name: 'Usage Cap Test Tenant' }),
    );
    await tenantPolicyService.upsert(tenantId, { confidenceThreshold: 0.5 });

    await persistence.runAdminQuery((db) =>
      db.insert(plans).values({
        id: planId,
        name: 'Tiny',
        stripePriceId: 'price_tiny',
        monthlyMessageLimit: MESSAGE_LIMIT,
        monthlySpendCapUsd: 1000, // high — this test exercises the message-limit branch
        trialDays: 0,
      }),
    );
    await tenantContext.withTenantTx(
      (tx) =>
        tx.insert(tenantSubscriptions).values({
          tenantId,
          planId,
          stripeCustomerId: `cus_${tenantId}`,
          stripeSubscriptionId: `sub_${tenantId}`,
          status: 'active',
        }),
      tenantId,
    );

    // Pre-seed usage already AT the message limit — no need to actually
    // drive MESSAGE_LIMIT real turns through the pipeline first.
    await tenantContext.withTenantTx(
      (tx) =>
        tx.insert(agentRuns).values(
          Array.from({ length: MESSAGE_LIMIT }, () => ({
            tenantId,
            status: 'success' as const,
            inputTokens: 10,
            outputTokens: 5,
            latencyMs: 100,
            spans: {},
          })),
        ),
      tenantId,
    );
  }, 30000);

  afterAll(async () => {
    await persistence.runAdminQuery((db) =>
      db.delete(tenants).where(eq(tenants.id, tenantId)),
    );
    await moduleRef.close();
    delete process.env.BURST_COALESCE_DEBOUNCE_MS;
  });

  it('force-escalates with USAGE_CAP_EXCEEDED and never calls the LLM once the tenant is at its monthly message limit', async () => {
    const phone = '+15550009999';
    await respondPathProducer.enqueue({
      tenantId,
      channel: 'whatsapp',
      channelAccountId: 'PHONE_NUMBER_ID',
      providerMessageId: `wamid.${randomUUID()}`,
      from: phone,
      text: 'One more message, please answer',
    });

    const newRunsForPhone = async () =>
      tenantContext.withTenantTx(
        (tx) =>
          tx.select().from(agentRuns).where(eq(agentRuns.status, 'escalated')),
        tenantId,
      );
    await waitUntil(async () => (await newRunsForPhone()).length >= 1);

    const escalatedRuns = await newRunsForPhone();
    expect(escalatedRuns).toHaveLength(1);
    expect(escalatedRuns[0]).toMatchObject({
      status: 'escalated',
      escalationReason: 'USAGE_CAP_EXCEEDED',
      inputTokens: 0,
      outputTokens: 0,
      promptVersion: null,
    });

    // The actual point of this test: the LLM was never reached at all.
    expect(llmProvider.callCount).toBe(0);
  });
});
