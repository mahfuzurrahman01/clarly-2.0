// RetentionModule (Feature 7, T16): "90-day transcript purge... removes
// raw transcripts but conversation_outcomes (T12) is untouched." Scoped to
// `conversations` only — its own `messages` FK (`onDelete: 'cascade'`)
// removes the actual message content in the same statement, while
// `tickets.conversationId`/`agent_runs.conversationId` (both `onDelete:
// 'set null'`) survive with the reference simply cleared, and
// `conversation_outcomes.conversationId` (deliberately no FK at all,
// Feature 7 Slice 3) is never touched regardless — this is the concrete
// mechanism T12's "survives a 90-day transcript purge" guarantee was
// built for.
//
// F13 amendment: message rows cascade, but the BYTES behind an inbound
// attachment live in object storage and no foreign key reaches them. Without
// the deletion below, a "purge" would leave every photo, voice note and
// document a customer ever sent sitting in a bucket forever — which is both a
// cost leak and a straightforwardly false retention claim.
import { Injectable } from '@nestjs/common';
import { and, eq, inArray, isNotNull, lt, sql } from 'drizzle-orm';
import { AppConfigService, AppLoggerService } from '../core';
import {
  conversations,
  messages,
  tenants,
} from '../persistence/drizzle/schema';
import { PersistenceService } from '../persistence/persistence.service';
import { ObjectStorage } from '../storage/ports/object-storage.port';
import { TenantContextService } from '../tenant-context/tenant-context.service';
import type { TranscriptPurgeResult } from './transcript-purge.dto';

@Injectable()
export class TranscriptPurgeService {
  constructor(
    private readonly persistence: PersistenceService,
    private readonly tenantContext: TenantContextService,
    private readonly config: AppConfigService,
    private readonly storage: ObjectStorage,
    private readonly logger: AppLoggerService,
  ) {}

  async purgeAllTenants(): Promise<TranscriptPurgeResult[]> {
    const tenantRows = await this.persistence.runAdminQuery((db) =>
      db.select({ id: tenants.id }).from(tenants),
    );

    const results = await Promise.all(
      tenantRows.map((tenant) => this.purgeTenant(tenant.id)),
    );

    return results.filter(
      (result): result is TranscriptPurgeResult =>
        result.conversationsPurged > 0,
    );
  }

  private async purgeTenant(tenantId: string): Promise<TranscriptPurgeResult> {
    const cutoff = new Date(
      Date.now() - this.config.transcriptRetentionDays * 24 * 60 * 60 * 1000,
    );

    const { result, storageKeys } = await this.tenantContext.withTenantTx(
      async (tx) => {
        const expiredConversations = await tx
          .select({ id: conversations.id })
          .from(conversations)
          .where(
            and(
              eq(conversations.tenantId, tenantId),
              lt(conversations.lastInboundAt, cutoff),
            ),
          );

        if (expiredConversations.length === 0) {
          return {
            result: { tenantId, conversationsPurged: 0, messagesPurged: 0 },
            storageKeys: [],
          };
        }
        const conversationIds = expiredConversations.map((row) => row.id);

        // Counted BEFORE the cascade delete below removes them — there's
        // nothing left to count against afterward.
        const [messageCountRow] = await tx
          .select({ count: sql<number>`count(*)::int` })
          .from(messages)
          .where(inArray(messages.conversationId, conversationIds));

        // Same reason, and more urgent: once the rows cascade there is no
        // record anywhere of which objects belonged to them, so a key not
        // collected here can never be found again.
        const mediaRows = await tx
          .select({ storageKey: messages.mediaStorageKey })
          .from(messages)
          .where(
            and(
              inArray(messages.conversationId, conversationIds),
              isNotNull(messages.mediaStorageKey),
            ),
          );

        await tx
          .delete(conversations)
          .where(inArray(conversations.id, conversationIds));

        return {
          result: {
            tenantId,
            conversationsPurged: conversationIds.length,
            messagesPurged: messageCountRow?.count ?? 0,
          },
          storageKeys: mediaRows
            .map((row) => row.storageKey)
            .filter((key): key is string => key !== null),
        };
      },
      tenantId,
    );

    await this.deleteStoredMedia(tenantId, storageKeys);
    return result;
  }

  /**
   * Deletes attachment bytes AFTER the transaction has committed.
   *
   * Order chosen deliberately, and neither order is free. Deleting first would
   * mean a rolled-back transaction leaves live conversations pointing at bytes
   * that are gone — unrecoverable, and visible to a tenant as attachments that
   * vanished from conversations they can still read. Deleting after means a
   * crash in between leaves orphaned objects, which is a cost leak and a
   * retention claim quietly unmet.
   *
   * The second is the recoverable one, so it is the one taken — but it is only
   * recoverable if someone is told, which is why a failure here logs at error
   * level rather than being swallowed.
   */
  private async deleteStoredMedia(
    tenantId: string,
    storageKeys: string[],
  ): Promise<void> {
    for (const storageKey of storageKeys) {
      try {
        await this.storage.delete(storageKey);
      } catch (error) {
        // Continue rather than abort: one unreachable object must not leave
        // the rest of this tenant's attachments undeleted.
        this.logger.error(
          `transcript purge for tenant ${tenantId} could not delete stored media ${storageKey}: ${
            error instanceof Error ? error.message : String(error)
          }. The row is already gone, so this object is now orphaned and must be removed by hand.`,
          TranscriptPurgeService.name,
        );
      }
    }
  }
}
