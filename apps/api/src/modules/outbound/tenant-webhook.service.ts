// Product shell (OutboundModule, F11): registering endpoints and queueing
// events for them.
import { Injectable, NotFoundException } from '@nestjs/common';
import { InjectQueue } from '@nestjs/bullmq';
import type { Queue } from 'bullmq';
import { and, eq } from 'drizzle-orm';
import { AppLoggerService } from '../core';
import {
  tenantWebhooks,
  type WebhookEvent,
} from '../persistence/drizzle/schema';
import { TenantContextService } from '../tenant-context/tenant-context.service';
import { BspCredentialsEncryptionService } from '../whatsapp/bsp-credentials-encryption.service';
import {
  OUTBOUND_WEBHOOK_QUEUE,
  type OutboundWebhookJobData,
} from './outbound-webhook.queue';
import { assertSafeWebhookUrl } from './webhook-url';

export interface TenantWebhookRecord {
  id: string;
  url: string;
  events: WebhookEvent[];
  enabled: boolean;
  lastSuccessAt: Date | null;
  lastFailureAt: Date | null;
  lastFailureReason: string | null;
}

@Injectable()
export class TenantWebhookService {
  constructor(
    private readonly tenantContext: TenantContextService,
    private readonly encryption: BspCredentialsEncryptionService,
    @InjectQueue(OUTBOUND_WEBHOOK_QUEUE)
    private readonly queue: Queue<OutboundWebhookJobData>,
    private readonly logger: AppLoggerService,
  ) {}

  /**
   * Fans an event out to every endpoint subscribed to it.
   *
   * Queued, never sent inline: this is called from the respond path, and a
   * tenant's slow endpoint must not add its latency to a customer's reply.
   * Failures here are swallowed for the same reason — losing a webhook is
   * bad, delaying or breaking the actual answer is worse.
   */
  async emit(
    tenantId: string,
    event: WebhookEvent,
    body: Record<string, unknown>,
  ): Promise<number> {
    try {
      const targets = await this.tenantContext.withTenantTx(
        (tx) =>
          tx
            .select({ id: tenantWebhooks.id, events: tenantWebhooks.events })
            .from(tenantWebhooks)
            .where(
              and(
                eq(tenantWebhooks.tenantId, tenantId),
                eq(tenantWebhooks.enabled, true),
              ),
            ),
        tenantId,
      );

      const subscribed = targets.filter((target) =>
        target.events.includes(event),
      );

      await Promise.all(
        subscribed.map((target) =>
          this.queue.add(event, {
            tenantId,
            webhookId: target.id,
            event,
            body,
          }),
        ),
      );

      return subscribed.length;
    } catch (error) {
      this.logger.error(
        `failed to queue ${event} webhooks for tenant ${tenantId}: ${
          error instanceof Error ? error.message : String(error)
        }`,
        'TenantWebhookService',
      );
      return 0;
    }
  }

  async list(tenantId: string): Promise<TenantWebhookRecord[]> {
    const rows = await this.tenantContext.withTenantTx(
      (tx) =>
        tx
          .select()
          .from(tenantWebhooks)
          .where(eq(tenantWebhooks.tenantId, tenantId)),
      tenantId,
    );
    return rows.map(toRecord);
  }

  /**
   * Registers an endpoint and returns the signing secret ONCE.
   *
   * Stored encrypted and never returned again: a secret a tenant can re-read
   * is a secret in every screenshot and support ticket they ever send us.
   */
  async create(
    tenantId: string,
    url: string,
    events: WebhookEvent[],
    secret: string,
  ): Promise<TenantWebhookRecord> {
    // Checked here as well as at delivery: a tenant should find out their URL
    // is unusable when they save it, not from a silent failure an hour later.
    await assertSafeWebhookUrl(url);

    const [row] = await this.tenantContext.withTenantTx(
      (tx) =>
        tx
          .insert(tenantWebhooks)
          .values({
            tenantId,
            url,
            events,
            // The encryption service takes an object, so the secret is
            // wrapped rather than stored raw — same envelope the BSP
            // credentials use, one keyed implementation to trust.
            secretEncrypted: this.encryption.encrypt({ secret }),
          })
          .returning(),
      tenantId,
    );
    return toRecord(row);
  }

  async remove(tenantId: string, id: string): Promise<void> {
    const rows = await this.tenantContext.withTenantTx(
      (tx) =>
        tx
          .delete(tenantWebhooks)
          .where(
            and(
              eq(tenantWebhooks.id, id),
              eq(tenantWebhooks.tenantId, tenantId),
            ),
          )
          .returning({ id: tenantWebhooks.id }),
      tenantId,
    );
    if (rows.length === 0) {
      throw new NotFoundException(`Webhook ${id} not found`);
    }
  }

  /** Used by the delivery worker. Decrypts the secret at the last possible moment. */
  async getForDelivery(
    tenantId: string,
    id: string,
  ): Promise<{ url: string; secret: string } | null> {
    const rows = await this.tenantContext.withTenantTx(
      (tx) =>
        tx
          .select({
            url: tenantWebhooks.url,
            secretEncrypted: tenantWebhooks.secretEncrypted,
            enabled: tenantWebhooks.enabled,
          })
          .from(tenantWebhooks)
          .where(
            and(
              eq(tenantWebhooks.id, id),
              eq(tenantWebhooks.tenantId, tenantId),
            ),
          )
          .limit(1),
      tenantId,
    );

    const row = rows[0];
    if (!row || !row.enabled) return null;

    return {
      url: row.url,
      secret: String(this.encryption.decrypt(row.secretEncrypted).secret),
    };
  }

  /** Delivery outcome, surfaced on the tenant's own screen so a broken endpoint is visible without reading our logs. */
  async recordOutcome(
    tenantId: string,
    id: string,
    outcome: { ok: boolean; error?: string },
  ): Promise<void> {
    await this.tenantContext.withTenantTx(
      (tx) =>
        tx
          .update(tenantWebhooks)
          .set(
            outcome.ok
              ? { lastSuccessAt: new Date(), updatedAt: new Date() }
              : {
                  lastFailureAt: new Date(),
                  lastFailureReason: outcome.error ?? 'unknown',
                  updatedAt: new Date(),
                },
          )
          .where(
            and(
              eq(tenantWebhooks.id, id),
              eq(tenantWebhooks.tenantId, tenantId),
            ),
          ),
      tenantId,
    );
  }
}

function toRecord(
  row: typeof tenantWebhooks.$inferSelect,
): TenantWebhookRecord {
  return {
    id: row.id,
    url: row.url,
    events: row.events,
    enabled: row.enabled,
    lastSuccessAt: row.lastSuccessAt,
    lastFailureAt: row.lastFailureAt,
    lastFailureReason: row.lastFailureReason,
  };
}
