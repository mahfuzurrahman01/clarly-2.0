// Feature 3/T10 (D8): "Postgres advisory lock per conversation_id for the
// run, plus a ~1.5s debounce window coalescing consecutive inbound
// messages into one turn." BACKEND_PLAN.md's own T10 verify line ("3
// messages sent 2s apart produce exactly one agent run") doesn't actually
// fit a 1.5s debounce window — a 2s gap exceeds it, so the window would
// already have fired between message 1 and message 2 under a genuine
// trailing-edge debounce. See docs/decisions/F3-agent-core.md's T10
// section for the full note; this suite proves the mechanism at spacing
// that's internally consistent with the ~1.5s design parameter (well
// inside the window), not the verify line's literal "2s" figure.
//
// Requires real Postgres + Redis + BullMQ. Run via `npm run test:integration`.
import { randomUUID } from 'node:crypto';
import { Test, type TestingModule } from '@nestjs/testing';
import { getQueueToken } from '@nestjs/bullmq';
import type { Queue } from 'bullmq';
import { eq } from 'drizzle-orm';
import { BurstCoalescingService } from '../../src/modules/conversation/burst-coalescing.service';
import type { CoalescedRespondJobData } from '../../src/modules/conversation/coalesced-respond-job.dto';
import { ConversationLockService } from '../../src/modules/conversation/conversation-lock.service';
import { ConversationModule } from '../../src/modules/conversation/conversation.module';
import { CoreModule } from '../../src/modules/core/core.module';
import { tenants, tickets } from '../../src/modules/persistence/drizzle/schema';
import { PersistenceModule } from '../../src/modules/persistence/persistence.module';
import { PersistenceService } from '../../src/modules/persistence/persistence.service';
import { RESPOND_PATH_QUEUE } from '../../src/modules/queue/queue.providers';
import { TenantContextModule } from '../../src/modules/tenant-context/tenant-context.module';
import { TenantContextService } from '../../src/modules/tenant-context/tenant-context.service';
import { WebhookModule } from '../../src/modules/webhook/webhook.module';

async function waitUntil(
  predicate: () => Promise<boolean>,
  timeoutMs = 5000,
): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (await predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error(`waitUntil() timed out after ${timeoutMs}ms`);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

describe('T10 — per-conversation serialization + burst coalescing', () => {
  let moduleRef: TestingModule;
  let persistence: PersistenceService;
  let tenantContext: TenantContextService;
  let burstCoalescing: BurstCoalescingService;
  let conversationLock: ConversationLockService;
  let respondPathQueue: Queue<CoalescedRespondJobData>;

  const tenantId = randomUUID();

  beforeAll(async () => {
    moduleRef = await Test.createTestingModule({
      // WebhookModule pulls in RespondPathProcessor (via ConversationModule's
      // own import chain would NOT be enough — the processor lives in
      // WebhookModule) so the ticket-creation test below exercises the real
      // worker, not just the producer side.
      imports: [
        CoreModule,
        PersistenceModule,
        TenantContextModule,
        ConversationModule,
        WebhookModule,
      ],
    }).compile();
    await moduleRef.init();

    persistence = moduleRef.get(PersistenceService);
    tenantContext = moduleRef.get(TenantContextService);
    burstCoalescing = moduleRef.get(BurstCoalescingService);
    conversationLock = moduleRef.get(ConversationLockService);
    respondPathQueue = moduleRef.get(getQueueToken(RESPOND_PATH_QUEUE));

    await persistence.runAdminQuery((db) =>
      db.insert(tenants).values({ id: tenantId, name: 'T10 Test Tenant' }),
    );
  });

  afterAll(async () => {
    await respondPathQueue.obliterate({ force: true });
    await persistence.runAdminQuery((db) =>
      db.delete(tickets).where(eq(tickets.tenantId, tenantId)),
    );
    await persistence.runAdminQuery((db) =>
      db.delete(tenants).where(eq(tenants.id, tenantId)),
    );
    await moduleRef.close();
  });

  it('D8: 3 messages arriving well within the debounce window coalesce into exactly one queued job', async () => {
    const from = `1555${randomUUID().slice(0, 7)}`;

    await burstCoalescing.recordMessage({
      tenantId,
      channel: 'whatsapp',
      channelAccountId: 'PHONE_NUMBER_ID',
      from,
      providerMessageId: 'm1',
      text: 'hi',
    });
    await sleep(150);
    await burstCoalescing.recordMessage({
      tenantId,
      channel: 'whatsapp',
      channelAccountId: 'PHONE_NUMBER_ID',
      from,
      providerMessageId: 'm2',
      text: 'my order is late',
    });
    await sleep(150);
    await burstCoalescing.recordMessage({
      tenantId,
      channel: 'whatsapp',
      channelAccountId: 'PHONE_NUMBER_ID',
      from,
      providerMessageId: 'm3',
      text: 'hello?',
    });

    // Each recordMessage() call's updateData()/changeDelay() is an async
    // Redis round-trip — poll rather than assume it's visible via
    // getJobs() the instant the last call resolves, especially under the
    // heavier load of the full integration suite running many DB/Redis-
    // touching files concurrently.
    let matching: Awaited<ReturnType<typeof respondPathQueue.getJobs>> = [];
    await waitUntil(async () => {
      const jobs = await respondPathQueue.getJobs([
        'delayed',
        'waiting',
        'active',
      ]);
      matching = jobs.filter(
        (job) => job.data.tenantId === tenantId && job.data.from === from,
      );
      return matching.length === 1 && matching[0]?.data.messages.length === 3;
    }, 5000);

    expect(matching).toHaveLength(1);
    expect(matching[0]?.data.messages.map((m) => m.providerMessageId)).toEqual([
      'm1',
      'm2',
      'm3',
    ]);
  });

  it('D8: once the debounce window elapses with no new messages, exactly one JOB_FAILURE ticket covers the whole coalesced batch (via the real queue + processor, not a mock)', async () => {
    const from = `1555${randomUUID().slice(0, 7)}`;

    await burstCoalescing.recordMessage({
      tenantId,
      channel: 'whatsapp',
      channelAccountId: 'PHONE_NUMBER_ID',
      from,
      providerMessageId: 'batch-1',
      text: 'hi',
    });
    await sleep(200);
    await burstCoalescing.recordMessage({
      tenantId,
      channel: 'whatsapp',
      channelAccountId: 'PHONE_NUMBER_ID',
      from,
      providerMessageId: 'batch-2',
      text: 'still there?',
    });

    // Default debounce (1500ms) + the placeholder processor's own retry
    // backoff before onFailed() creates the ticket — generous timeout.
    await waitUntil(async () => {
      const rows = await tenantContext.withTenantTx(
        (tx) =>
          tx
            .select()
            .from(tickets)
            .where(eq(tickets.escalationReason, 'JOB_FAILURE')),
        tenantId,
      );
      return rows.some(
        (row) => row.note?.includes('batch-1') && row.note?.includes('batch-2'),
      );
    }, 15000);

    const rows = await tenantContext.withTenantTx(
      (tx) =>
        tx
          .select()
          .from(tickets)
          .where(eq(tickets.escalationReason, 'JOB_FAILURE')),
      tenantId,
    );
    const matchingTickets = rows.filter((row) => row.note?.includes('batch-1'));
    // Exactly one ticket for this batch — not two (T10's whole point: not
    // "two concurrent LLM runs, two replies").
    expect(matchingTickets).toHaveLength(1);
  }, 20000);

  it('D8: two different conversations (different phone numbers) get independent coalescing windows, never merged', async () => {
    const fromA = `1555${randomUUID().slice(0, 7)}`;
    const fromB = `1555${randomUUID().slice(0, 7)}`;

    await burstCoalescing.recordMessage({
      tenantId,
      channel: 'whatsapp',
      channelAccountId: 'PHONE_NUMBER_ID',
      from: fromA,
      providerMessageId: 'a-1',
      text: 'hi',
    });
    await burstCoalescing.recordMessage({
      tenantId,
      channel: 'whatsapp',
      channelAccountId: 'PHONE_NUMBER_ID',
      from: fromB,
      providerMessageId: 'b-1',
      text: 'hi',
    });

    const jobs = await respondPathQueue.getJobs([
      'delayed',
      'waiting',
      'active',
    ]);
    const jobsA = jobs.filter((job) => job.data.from === fromA);
    const jobsB = jobs.filter((job) => job.data.from === fromB);

    expect(jobsA).toHaveLength(1);
    expect(jobsB).toHaveLength(1);
    expect(jobsA[0]?.data.messages.map((m) => m.providerMessageId)).toEqual([
      'a-1',
    ]);
    expect(jobsB[0]?.data.messages.map((m) => m.providerMessageId)).toEqual([
      'b-1',
    ]);
  });

  it('D8: ConversationLockService.withLock() serializes concurrent callers for the same conversation key — the second never overlaps the first', async () => {
    const conversationKey = `conv-${randomUUID()}`;
    const events: string[] = [];

    const first = conversationLock.withLock(
      tenantId,
      conversationKey,
      async () => {
        events.push('first-start');
        await sleep(200);
        events.push('first-end');
      },
    );
    // Give the first call a head start so it acquires the lock first.
    await sleep(20);
    const second = conversationLock.withLock(
      tenantId,
      conversationKey,
      async () => {
        events.push('second-start');
        await sleep(20);
        events.push('second-end');
      },
    );

    await Promise.all([first, second]);

    expect(events).toEqual([
      'first-start',
      'first-end',
      'second-start',
      'second-end',
    ]);
  });

  it('D8: ConversationLockService.withLock() does NOT serialize callers with different conversation keys', async () => {
    const events: string[] = [];

    const a = conversationLock.withLock(
      tenantId,
      `conv-${randomUUID()}`,
      async () => {
        events.push('a-start');
        await sleep(150);
        events.push('a-end');
      },
    );
    await sleep(20);
    const b = conversationLock.withLock(
      tenantId,
      `conv-${randomUUID()}`,
      async () => {
        events.push('b-start');
        await sleep(20);
        events.push('b-end');
      },
    );

    await Promise.all([a, b]);

    // b starts and finishes while a is still running — proof the lock is
    // scoped per-key, not a single global lock.
    expect(events.indexOf('b-start')).toBeLessThan(events.indexOf('a-end'));
  });
});
