// OutcomesModule (Feature 7, A9): the periodic half of the close resolver
// — finds conversations that never escalated (no ticket ever created) and
// have gone quiet past the inactivity threshold, and haven't already been
// recorded (a conversation is swept at most once; re-sweeping an already-
// closed conversation would produce duplicate outcome rows). Two
// correlated NOT EXISTS subqueries do the filtering in the database
// itself rather than pulling every conversation into the app and
// filtering in memory — correct behavior at any data volume.
import { Injectable } from '@nestjs/common';
import { and, eq, lt, notExists, sql } from 'drizzle-orm';
import {
  AppConfigService,
  AppLoggerService,
  sweepTenantsWithBoundedConcurrency,
} from '../core';
import {
  conversationOutcomes,
  conversations,
  tenants,
  tickets,
} from '../persistence/drizzle/schema';
import { PersistenceService } from '../persistence/persistence.service';
import { TenantContextService } from '../tenant-context/tenant-context.service';
import { ConversationOutcomeService } from './conversation-outcome.service';

export interface AutoClosedConversation {
  tenantId: string;
  conversationId: string;
  closedAt: Date;
}

@Injectable()
export class AutoCloseSweepService {
  constructor(
    private readonly persistence: PersistenceService,
    private readonly tenantContext: TenantContextService,
    private readonly conversationOutcome: ConversationOutcomeService,
    private readonly config: AppConfigService,
    private readonly logger: AppLoggerService,
  ) {}

  /**
   * Bounded concurrency, one tenant's failure never dropping the rest — see
   * sweep-tenants.ts's own doc comment for why the previous bare
   * `Promise.all(tenantRows.map(...))` here was the actual cause of this
   * sweep landing in the BullMQ failed set as tenant count grew.
   */
  async sweepAllTenants(): Promise<AutoClosedConversation[]> {
    const tenantRows = await this.persistence.runAdminQuery((db) =>
      db.select({ id: tenants.id }).from(tenants),
    );

    const results = await sweepTenantsWithBoundedConcurrency(
      tenantRows.map((tenant) => tenant.id),
      (tenantId) => this.sweepTenant(tenantId),
      { logger: this.logger, sweepName: 'auto-close-sweep' },
    );

    return results.flatMap((result) => result.value);
  }

  private async sweepTenant(
    tenantId: string,
  ): Promise<AutoClosedConversation[]> {
    const cutoff = new Date(
      Date.now() - this.config.autoCloseInactivityHours * 60 * 60 * 1000,
    );

    const candidates = await this.tenantContext.withTenantTx((tx) => {
      const hasTicket = tx
        .select({ one: sql`1` })
        .from(tickets)
        .where(eq(tickets.conversationId, conversations.id));
      const hasOutcome = tx
        .select({ one: sql`1` })
        .from(conversationOutcomes)
        .where(eq(conversationOutcomes.conversationId, conversations.id));

      return tx
        .select({ id: conversations.id })
        .from(conversations)
        .where(
          and(
            eq(conversations.tenantId, tenantId),
            lt(conversations.lastInboundAt, cutoff),
            notExists(hasTicket),
            notExists(hasOutcome),
          ),
        );
    }, tenantId);

    const closed: AutoClosedConversation[] = [];
    for (const candidate of candidates) {
      const closedAt = new Date();
      await this.conversationOutcome.recordAutoResolved(
        tenantId,
        candidate.id,
        closedAt,
      );
      closed.push({ tenantId, conversationId: candidate.id, closedAt });
    }
    return closed;
  }
}
