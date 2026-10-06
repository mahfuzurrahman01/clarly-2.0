// Channel (WebhookModule, T6): dedup on BSP message ID before any
// respond-path work happens. The unique(tenantId, bspMessageId) constraint
// on webhook_message_dedup (RLS-scoped, Feature 1's pattern) IS the dedup
// mechanism — checkAndRecord() attempts an insert and treats a Postgres
// unique-violation (code 23505) as "already processed," not an error.
import { Injectable } from '@nestjs/common';
import { webhookMessageDedup } from '../persistence/drizzle/schema';
import { isUniqueViolation } from '../persistence/postgres-error';
import { TenantContextService } from '../tenant-context/tenant-context.service';

@Injectable()
export class WebhookDedupService {
  constructor(private readonly tenantContext: TenantContextService) {}

  /** Returns `{ isDuplicate: true }` without throwing if this (tenantId, bspMessageId) pair was already recorded. */
  async checkAndRecord(
    tenantId: string,
    bspMessageId: string,
  ): Promise<{ isDuplicate: boolean }> {
    try {
      await this.tenantContext.withTenantTx(
        (tx) =>
          tx.insert(webhookMessageDedup).values({ tenantId, bspMessageId }),
        tenantId,
      );
      return { isDuplicate: false };
    } catch (error) {
      if (isUniqueViolation(error)) {
        return { isDuplicate: true };
      }
      throw error;
    }
  }
}
