// Product shell (NotificationsModule, T4/T18): the durable half of alerting.
import { Injectable } from '@nestjs/common';
import { and, desc, eq, isNull, sql } from 'drizzle-orm';
import { notifications } from '../persistence/drizzle/schema';
import { TenantContextService } from '../tenant-context/tenant-context.service';
import type {
  NotificationRecord,
  RecordNotificationInput,
} from './notification.dto';

@Injectable()
export class NotificationService {
  constructor(private readonly tenantContext: TenantContextService) {}

  /**
   * Writes the notification unless one with the same `dedupKey` already
   * exists for this tenant.
   *
   * `onConflictDoNothing` rather than a select-then-insert: the alert sweeps
   * that call this run on timers and can overlap, and a check-then-write
   * would race into duplicates exactly when a condition is worst. Returns
   * whether a row was actually created, so callers can log the difference
   * between "new problem" and "same problem, still there".
   */
  async record(input: RecordNotificationInput): Promise<boolean> {
    const rows = await this.tenantContext.withTenantTx(
      (tx) =>
        tx
          .insert(notifications)
          .values({
            tenantId: input.tenantId,
            kind: input.kind,
            severity: input.severity,
            title: input.title,
            body: input.body,
            params: { ...input.params },
            entityType: input.entityType ?? null,
            entityId: input.entityId ?? null,
            dedupKey: input.dedupKey,
          })
          .onConflictDoNothing({
            target: [notifications.tenantId, notifications.dedupKey],
          })
          .returning({ id: notifications.id }),
      input.tenantId,
    );

    return rows.length > 0;
  }

  /** Newest first. `unreadOnly` is what the console's bell icon opens to. */
  async list(
    tenantId: string,
    options: { unreadOnly?: boolean; limit: number },
  ): Promise<NotificationRecord[]> {
    const rows = await this.tenantContext.withTenantTx(
      (tx) =>
        tx
          .select()
          .from(notifications)
          .where(
            options.unreadOnly
              ? and(
                  eq(notifications.tenantId, tenantId),
                  isNull(notifications.readAt),
                )
              : eq(notifications.tenantId, tenantId),
          )
          .orderBy(desc(notifications.createdAt))
          .limit(options.limit),
      tenantId,
    );

    return rows.map(toRecord);
  }

  async unreadCount(tenantId: string): Promise<number> {
    const [row] = await this.tenantContext.withTenantTx(
      (tx) =>
        tx
          .select({ count: sql<number>`count(*)::int` })
          .from(notifications)
          .where(
            and(
              eq(notifications.tenantId, tenantId),
              isNull(notifications.readAt),
            ),
          ),
      tenantId,
    );
    return Number(row?.count ?? 0);
  }

  /** Idempotent: marking an already-read notification keeps its original read time rather than moving it. */
  async markRead(tenantId: string, id: string): Promise<boolean> {
    const rows = await this.tenantContext.withTenantTx(
      (tx) =>
        tx
          .update(notifications)
          .set({ readAt: new Date() })
          .where(
            and(
              eq(notifications.id, id),
              eq(notifications.tenantId, tenantId),
              isNull(notifications.readAt),
            ),
          )
          .returning({ id: notifications.id }),
      tenantId,
    );
    return rows.length > 0;
  }

  async markAllRead(tenantId: string): Promise<number> {
    const rows = await this.tenantContext.withTenantTx(
      (tx) =>
        tx
          .update(notifications)
          .set({ readAt: new Date() })
          .where(
            and(
              eq(notifications.tenantId, tenantId),
              isNull(notifications.readAt),
            ),
          )
          .returning({ id: notifications.id }),
      tenantId,
    );
    return rows.length;
  }
}

function toRecord(row: typeof notifications.$inferSelect): NotificationRecord {
  return {
    id: row.id,
    kind: row.kind as NotificationRecord['kind'],
    severity: row.severity as NotificationRecord['severity'],
    title: row.title,
    body: row.body,
    params: row.params ?? {},
    entityType: row.entityType,
    entityId: row.entityId,
    readAt: row.readAt,
    createdAt: row.createdAt,
  };
}
