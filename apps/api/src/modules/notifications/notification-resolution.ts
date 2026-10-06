// Retiring a notification once the thing it asked for has been done.
//
// A notification that says "order X is waiting for approval" is a lie the
// moment someone approves it, and a bell badge that still counts it teaches the
// team to ignore the bell. So the code path that ACTS on the subject marks its
// notifications read, in the same transaction as the action itself: the order
// is approved and its prompt is retired together, or neither happens.
//
// A plain function over a transaction rather than a NotificationService method
// on purpose: `NotificationService` opens its own `withTenantTx`, which is a
// second connection and therefore a second transaction (see order.service.ts's
// header for the same reasoning on the write side).
import { and, eq, inArray, isNull } from 'drizzle-orm';
import {
  notifications,
  type NotificationKind,
} from '../persistence/drizzle/schema';
import type { DrizzleDb } from '../persistence/persistence.providers';

export interface ResolveEntityNotificationsInput {
  tenantId: string;
  /** Matches `notifications.entity_type` ('order', 'ticket', 'campaign'). */
  entityType: string;
  entityIds: readonly string[];
  /** Only these kinds are retired: an action on an order settles its approval prompt, not an unrelated failure about it. */
  kinds: readonly NotificationKind[];
  readAt: Date;
}

/**
 * Marks the matching unread notifications read and returns how many it
 * changed. Already-read rows are left alone so their original read time
 * stands, exactly as `NotificationService.markRead` does.
 */
export async function markEntityNotificationsRead(
  tx: DrizzleDb,
  input: ResolveEntityNotificationsInput,
): Promise<number> {
  if (input.entityIds.length === 0 || input.kinds.length === 0) return 0;

  const rows = await tx
    .update(notifications)
    .set({ readAt: input.readAt })
    .where(
      and(
        eq(notifications.tenantId, input.tenantId),
        eq(notifications.entityType, input.entityType),
        inArray(notifications.entityId, [...input.entityIds]),
        inArray(notifications.kind, [...input.kinds]),
        isNull(notifications.readAt),
      ),
    )
    .returning({ id: notifications.id });

  return rows.length;
}
