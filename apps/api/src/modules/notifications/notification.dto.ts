import type {
  NotificationKind,
  NotificationSeverity,
} from '../persistence/drizzle/schema';
import type { NotificationParams } from './notification-content';

export interface NotificationRecord {
  id: string;
  kind: NotificationKind;
  severity: NotificationSeverity;
  title: string;
  body: string;
  /** The values interpolated into `title`/`body`, keyed per `kind`. `{}` on rows written before they were recorded. */
  params: NotificationParams;
  entityType: string | null;
  entityId: string | null;
  readAt: Date | null;
  createdAt: Date;
}

export interface RecordNotificationInput {
  tenantId: string;
  kind: NotificationKind;
  severity: NotificationSeverity;
  title: string;
  body: string;
  /** Required so no producer can write a notification the console cannot localise. Build title/body/params together with `notificationContent`. */
  params: NotificationParams;
  entityType?: string | null;
  entityId?: string | null;
  /** See notifications.table.ts — this is what stops a re-fired condition becoming a wall of identical rows. */
  dedupKey: string;
}
