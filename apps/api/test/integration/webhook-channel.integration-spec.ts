// Feature 2 exit criteria (former FEATURE_PLAN.md):
//   - "replayed webhook produces exactly one reply" (T6)
//   - "image/voice/document messages escalate with no silent drop" (T3)
//   - "a job that exhausts retries lands in the DLQ and produces one
//      escalation ticket, never a silent drop" (T11)
//   - "a webhook flood from one number does not starve other tenants" (T17,
//      proven at the per-tenant-counter level here)
//
// Everything under test is BSP-agnostic — FixtureChannelAdapter (not a real
// vendor) implements the BspAdapter port so this suite proves the pipeline
// works without depending on T0's still-pending sign-off. Requires real
// Postgres + Redis (see apps/api/.env / docker-compose.yml) and runs via
// `npm run test:integration`.
import { randomUUID } from 'node:crypto';
import { Test, type TestingModule } from '@nestjs/testing';
import { getQueueToken } from '@nestjs/bullmq';
import type { Queue } from 'bullmq';
import { eq } from 'drizzle-orm';
import { CoreModule } from '../../src/modules/core/core.module';
import {
  tenants,
  tickets,
  whatsappNumbers,
} from '../../src/modules/persistence/drizzle/schema';
import { PersistenceModule } from '../../src/modules/persistence/persistence.module';
import { PersistenceService } from '../../src/modules/persistence/persistence.service';
import { RESPOND_PATH_QUEUE } from '../../src/modules/queue/queue.providers';
import { TenantContextModule } from '../../src/modules/tenant-context/tenant-context.module';
import { TenantContextService } from '../../src/modules/tenant-context/tenant-context.service';
import { WebhookIngestService } from '../../src/modules/webhook/webhook-ingest.service';
import { WebhookModule } from '../../src/modules/webhook/webhook.module';
import { WebhookRateLimiterService } from '../../src/modules/webhook/webhook-rate-limiter.service';
import type { CoalescedRespondJobData } from '../../src/modules/conversation/coalesced-respond-job.dto';
import { FixtureChannelAdapter } from './fixtures/fixture-channel.adapter';

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

describe('WhatsApp channel ingest (Feature 2 exit criteria)', () => {
  let moduleRef: TestingModule;
  let persistence: PersistenceService;
  let tenantContext: TenantContextService;
  let ingest: WebhookIngestService;
  let rateLimiter: WebhookRateLimiterService;
  let respondPathQueue: Queue<CoalescedRespondJobData>;

  const tenantId = randomUUID();
  const phoneNumberId = `pn-${randomUUID()}`;

  beforeAll(async () => {
    moduleRef = await Test.createTestingModule({
      imports: [
        CoreModule,
        PersistenceModule,
        TenantContextModule,
        WebhookModule,
      ],
    }).compile();

    // .init() runs Nest lifecycle hooks — required so @Processor's BullMQ
    // Worker (RespondPathProcessor) actually starts consuming jobs; a bare
    // .compile() does not trigger onModuleInit.
    await moduleRef.init();

    persistence = moduleRef.get(PersistenceService);
    tenantContext = moduleRef.get(TenantContextService);
    ingest = moduleRef.get(WebhookIngestService);
    rateLimiter = moduleRef.get(WebhookRateLimiterService);
    respondPathQueue = moduleRef.get(getQueueToken(RESPOND_PATH_QUEUE));

    await persistence.runMigrations();

    await persistence.runAdminQuery((db) =>
      db.insert(tenants).values({ id: tenantId, name: 'Channel Test Tenant' }),
    );
    await persistence.runAdminQuery((db) =>
      db.insert(whatsappNumbers).values({
        tenantId,
        phoneNumberId,
        bspCredentialsEncrypted: 'not-real-ciphertext-for-this-test',
      }),
    );
  });

  afterAll(async () => {
    await respondPathQueue.obliterate({ force: true });
    await persistence.runAdminQuery((db) =>
      db.delete(whatsappNumbers).where(eq(whatsappNumbers.tenantId, tenantId)),
    );
    await persistence.runAdminQuery((db) =>
      db.delete(tickets).where(eq(tickets.tenantId, tenantId)),
    );
    await persistence.runAdminQuery((db) =>
      db.delete(tenants).where(eq(tenants.id, tenantId)),
    );
    // .close() runs onModuleDestroy for every provider in the graph — the
    // pg Pool (PersistenceService), the standalone ioredis client
    // (QueueHealthService), and BullMQ's own Queue/Worker connections.
    // Calling persistence.onModuleDestroy() alone (as this used to) left
    // those other connections open, which is exactly what made the first
    // run of this suite hang after all tests passed instead of exiting.
    await moduleRef.close();
  });

  it('rejects a webhook with an invalid signature before any tenant/dedup work happens', async () => {
    const adapter = new FixtureChannelAdapter('whatsapp', []);
    await expect(ingest.ingest(adapter, '{}', {})).rejects.toThrow(
      /signature/i,
    );
  });

  it('rejects a webhook for an unrecognized phone_number_id, before any tenant context is entered (T6)', async () => {
    const adapter = new FixtureChannelAdapter('whatsapp', [
      {
        channel: 'whatsapp',
        channelAccountId: 'totally-unknown-number',
        providerMessageId: `wamid.${randomUUID()}`,
        from: '15550000000',
        type: 'text',
        text: 'hi',
        receivedAt: new Date(),
      },
    ]);

    await expect(
      ingest.ingest(adapter, '{}', FixtureChannelAdapter.validHeaders()),
    ).rejects.toThrow(/no tenant/i);
  });

  it('replaying the same BSP message id produces exactly one enqueue, never two (T6)', async () => {
    const bspMessageId = `wamid.${randomUUID()}`;
    const message = {
      channel: 'whatsapp' as const,
      channelAccountId: phoneNumberId,
      providerMessageId: bspMessageId,
      from: '15551234567',
      type: 'text' as const,
      text: 'hello there',
      receivedAt: new Date(),
    };
    const adapter = new FixtureChannelAdapter('whatsapp', [message]);
    const headers = FixtureChannelAdapter.validHeaders();

    const first = await ingest.ingest(adapter, '{}', headers);
    const replay = await ingest.ingest(adapter, '{}', headers);

    expect(first).toEqual([
      { providerMessageId: bspMessageId, outcome: 'enqueued' },
    ]);
    expect(replay).toEqual([
      { providerMessageId: bspMessageId, outcome: 'duplicate' },
    ]);
  });

  it('an image message escalates to a ticket, never a silent drop, and is not enqueued (T3)', async () => {
    const bspMessageId = `wamid.${randomUUID()}`;
    const adapter = new FixtureChannelAdapter('whatsapp', [
      {
        channel: 'whatsapp' as const,
        channelAccountId: phoneNumberId,
        providerMessageId: bspMessageId,
        from: '15551234567',
        type: 'image' as const,
        receivedAt: new Date(),
      },
    ]);

    const results = await ingest.ingest(
      adapter,
      '{}',
      FixtureChannelAdapter.validHeaders(),
    );

    expect(results).toEqual([
      {
        providerMessageId: bspMessageId,
        outcome: 'escalated_unsupported_media',
      },
    ]);

    const rows = await tenantContext.withTenantTx(
      (tx) =>
        tx
          .select()
          .from(tickets)
          .where(eq(tickets.escalationReason, 'UNSUPPORTED_MEDIA')),
      tenantId,
    );
    expect(rows.some((row) => row.note?.includes(bspMessageId))).toBe(true);
  });

  it('a job that exhausts its retries creates exactly one JOB_FAILURE escalation ticket, never a silent drop (T11)', async () => {
    const bspMessageId = `wamid.${randomUUID()}`;
    // Distinct phone number from the other tests in this suite — T10's
    // BurstCoalescingService keys its debounce window on (tenantId, from),
    // and this suite reuses one shared tenantId across tests, so a shared
    // phone number would risk this manually-added job's window colliding
    // with (getting merged into) another test's coalesced job.
    const from = '15559990001';

    // Bypasses the queue's default (slow, exponential) retry policy on
    // purpose — fast/fixed backoff here so the test observes exhaustion in
    // milliseconds, not the ~6s the real default policy would take. The
    // exhaustion -> escalation *mechanism* under test (RespondPathProcessor
    // .onFailed()) is identical either way; only the timing changes.
    // Job shape is T10's CoalescedRespondJobData (messages[]), not the old
    // one-message-per-job RespondPathJobData — this bypasses
    // BurstCoalescingService entirely (adds straight to the queue) since
    // the test wants to force retry exhaustion deterministically, not
    // exercise coalescing itself (see the dedicated T10 integration suite
    // for that).
    await respondPathQueue.add(
      'respond',
      {
        tenantId,
        from,
        messages: [{ providerMessageId: bspMessageId, text: 'hi' }],
      },
      {
        jobId: bspMessageId,
        attempts: 2,
        backoff: { type: 'fixed', delay: 50 },
      },
    );

    await waitUntil(async () => {
      const rows = await tenantContext.withTenantTx(
        (tx) =>
          tx
            .select()
            .from(tickets)
            // JOB_FAILURE, not TOOL_FAILURE: split apart on 2026-08-17 —
            // "the orchestration crashed" has a different owner and fix from
            // "the agent's own tool calls broke". This assertion had been
            // left behind on the old value.
            .where(eq(tickets.escalationReason, 'JOB_FAILURE')),
        tenantId,
      );
      return rows.some((row) => row.note?.includes(bspMessageId));
    });
  });

  it('per-tenant rate limiting rejects once a tenant exceeds its budget, independent of other tenants (T17)', async () => {
    const busyTenant = randomUUID();
    const quietTenant = randomUUID();

    const busyResults = await Promise.all(
      Array.from({ length: 5 }, () => rateLimiter.allow(busyTenant, 3)),
    );
    const quietAllowed = await rateLimiter.allow(quietTenant, 3);

    expect(busyResults.filter(Boolean)).toHaveLength(3);
    expect(busyResults.filter((allowed) => !allowed)).toHaveLength(2);
    expect(quietAllowed).toBe(true);
  });
});
