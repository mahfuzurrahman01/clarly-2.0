import { createZodDto } from 'nestjs-zod';
import { z } from 'zod';
import {
  NOTIFICATION_KINDS,
  NOTIFICATION_SEVERITIES,
} from '../persistence/drizzle/schema';
import { isoTimestamp } from '../../common/iso-timestamp';

export const listNotificationsQuerySchema = z.object({
  unreadOnly: z
    .enum(['true', 'false'])
    .transform((value) => value === 'true')
    .optional()
    .describe(
      'Only notifications nobody has read yet — what the bell opens to.',
    ),
  limit: z.coerce.number().int().min(1).max(100).default(50),
});

export type ListNotificationsQuery = z.infer<
  typeof listNotificationsQuerySchema
>;
export class ListNotificationsQueryDto extends createZodDto(
  listNotificationsQuerySchema,
) {}

export const notificationRecordSchema = z.object({
  id: z.string().uuid(),
  kind: z.enum(NOTIFICATION_KINDS),
  severity: z.enum(NOTIFICATION_SEVERITIES),
  title: z
    .string()
    .describe(
      'English. The fallback when the console has no translation for `kind`.',
    ),
  body: z.string().describe('English, same fallback role as `title`.'),
  params: z
    .record(z.union([z.string(), z.number()]))
    .describe(
      'The values interpolated into title/body, keyed per `kind` (see docs/HANDOFF.md). `{}` for notifications recorded before params existed.',
    ),
  entityType: z
    .string()
    .nullable()
    .describe(
      "What it is about: 'ticket', 'order', 'campaign' or 'courier_connection'. Null for workspace-wide conditions.",
    ),
  entityId: z.string().uuid().nullable(),
  readAt: isoTimestamp().nullable(),
  createdAt: isoTimestamp(),
});

export class NotificationListDto extends createZodDto(
  z.array(notificationRecordSchema),
) {}

export const unreadCountSchema = z.object({ unread: z.number().int() });
export class UnreadCountDto extends createZodDto(unreadCountSchema) {}
