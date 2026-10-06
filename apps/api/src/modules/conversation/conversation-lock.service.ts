// T10/D8: "Postgres advisory lock per conversation_id for the run." D7's
// module-boundary summary elsewhere says "Redis is cache/lock only," which
// reads as if the lock itself were Redis-based — T10's own task
// description is the more specific, directly-on-topic source and is what
// this implements; see docs/decisions/F3-agent-core.md for the full note
// on that apparent inconsistency.
//
// Uses a transaction-scoped advisory lock (`pg_advisory_xact_lock`), not a
// session-scoped one (`pg_advisory_lock`) — xact-scoped locks release
// automatically at COMMIT/ROLLBACK, so a crash or thrown error inside `fn`
// can never leak a held lock the way a session-scoped lock forgetting to
// unlock would. `TenantContextService.withTenantTx()` already opens
// exactly the transaction this lock needs to be scoped to.
import { Injectable } from '@nestjs/common';
import { sql } from 'drizzle-orm';
import { TenantContextService } from '../tenant-context/tenant-context.service';

@Injectable()
export class ConversationLockService {
  constructor(private readonly tenantContext: TenantContextService) {}

  /**
   * Serializes `fn` against any other call currently holding the lock for
   * the same `conversationKey` — a second caller blocks until the first's
   * transaction commits or rolls back, never runs concurrently.
   * `hashtext()` on two different derived strings gives the 2-int32
   * overload's full 64 bits of key space from a single string input,
   * rather than requiring the caller to supply two independent keys.
   */
  async withLock<T>(
    tenantId: string,
    conversationKey: string,
    fn: () => Promise<T>,
  ): Promise<T> {
    return this.tenantContext.withTenantTx(async (tx) => {
      await tx.execute(
        sql`SELECT pg_advisory_xact_lock(hashtext(${conversationKey}), hashtext(${conversationKey} || ':lock'))`,
      );
      return fn();
    }, tenantId);
  }
}
