import { createZodDto } from 'nestjs-zod';
import { z } from 'zod';
import { isoTimestamp } from '../../common/iso-timestamp';
import {
  WIDGET_LOCALES,
  WIDGET_POSITIONS,
} from '../persistence/drizzle/schema';
import { isAcceptableOrigin, normaliseOrigin } from './widget-origin';

// --- tenant configuration --------------------------------------------------

export const widgetConfigSchema = z.object({
  id: z.string().uuid(),
  publicKey: z
    .string()
    .describe('Goes in the embed snippet. Public by design.'),
  enabled: z.boolean(),
  allowedOrigins: z.array(z.string()),
  title: z.string().nullable(),
  welcomeMessage: z.string().nullable(),
  accentColor: z.string(),
  position: z.enum(WIDGET_POSITIONS),
  locale: z.enum(WIDGET_LOCALES),
  updatedAt: isoTimestamp(),
});
export type WidgetConfigRecord = z.infer<typeof widgetConfigSchema>;
export class WidgetConfigDto extends createZodDto(widgetConfigSchema) {}

export const updateWidgetBodySchema = z
  .object({
    enabled: z.boolean().optional(),
    allowedOrigins: z
      .array(
        z
          .string()
          .trim()
          .refine(
            isAcceptableOrigin,
            'An https origin such as https://shop.example.com (http only for localhost)',
          )
          .transform((v) => normaliseOrigin(v) as string),
      )
      .max(20)
      .transform((list) => [...new Set(list)])
      .optional(),
    title: z.string().trim().max(60).nullable().optional(),
    welcomeMessage: z.string().trim().max(300).nullable().optional(),
    accentColor: z
      .string()
      .regex(/^#[0-9A-Fa-f]{6}$/, 'A hex colour like #16181D')
      .optional(),
    position: z.enum(WIDGET_POSITIONS).optional(),
    locale: z.enum(WIDGET_LOCALES).optional(),
  })
  .strict();
export type UpdateWidgetBody = z.infer<typeof updateWidgetBodySchema>;
export class UpdateWidgetBodyDto extends createZodDto(updateWidgetBodySchema) {}

// --- public (visitor) ------------------------------------------------------

const publicKey = z
  .string()
  .regex(/^wk_[A-Za-z0-9]{24}$/, 'Invalid widget key');

export const publicConfigQuerySchema = z.object({ key: publicKey });

export const publicSessionBodySchema = z.object({ key: publicKey }).strict();

export const publicSendBodySchema = z
  .object({
    key: publicKey,
    visitorId: z.string().max(64),
    token: z.string().max(128),
    clientMessageId: z.string().uuid(),
    text: z.string().trim().min(1).max(2000),
  })
  .strict();
export type PublicSendBody = z.infer<typeof publicSendBodySchema>;

export const publicMessagesQuerySchema = z.object({
  key: publicKey,
  visitorId: z.string().max(64),
  token: z.string().max(128),
  after: z.coerce.date().optional(),
});
export type PublicMessagesQuery = z.infer<typeof publicMessagesQuerySchema>;

export interface PublicWidgetConfig {
  title: string | null;
  welcomeMessage: string | null;
  accentColor: string;
  position: 'right' | 'left';
  locale: 'auto' | 'ar' | 'en';
  businessName: string;
}

export interface PublicWidgetMessage {
  id: string;
  from: 'visitor' | 'business';
  text: string;
  /** The widget's own id for a message it sent, so it can replace its optimistic copy. */
  clientMessageId: string | null;
  createdAt: Date;
}
