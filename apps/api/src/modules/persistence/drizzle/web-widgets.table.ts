import { pgTable, uuid, text, boolean, timestamp } from 'drizzle-orm/pg-core';
import { tenants } from './tenants.table';

export const WIDGET_POSITIONS = ['right', 'left'] as const;
export type WidgetPosition = (typeof WIDGET_POSITIONS)[number];

export const WIDGET_LOCALES = ['auto', 'ar', 'en'] as const;
export type WidgetLocale = (typeof WIDGET_LOCALES)[number];

/**
 * Clarly 2.0 S3 (migration 0072): a tenant's website chat widget. Not
 * RLS-scoped — a resolution table like `whatsapp_numbers` — so every tenant
 * read/write MUST filter on `tenantId` (WidgetConfigService does, and its spec
 * asserts it). `id` is the `channelAccountId` of the `web` channel.
 */
export const webWidgets = pgTable('web_widgets', {
  id: uuid('id').primaryKey().defaultRandom(),
  tenantId: uuid('tenant_id')
    .notNull()
    .unique('web_widgets_tenant_unique')
    .references(() => tenants.id, { onDelete: 'cascade' }),
  /** `wk_` + 24 random base62 characters. Public by design: it is in the embed snippet. */
  publicKey: text('public_key')
    .notNull()
    .unique('web_widgets_public_key_unique'),
  enabled: boolean('enabled').notNull().default(false),
  /** Exact origins (`https://shop.example.com`) allowed to load the widget. Empty = none. */
  allowedOrigins: text('allowed_origins').array().notNull().default([]),
  title: text('title'),
  welcomeMessage: text('welcome_message'),
  accentColor: text('accent_color').notNull().default('#16181D'),
  position: text('position').$type<WidgetPosition>().notNull().default('right'),
  locale: text('locale').$type<WidgetLocale>().notNull().default('auto'),
  createdAt: timestamp('created_at', { withTimezone: true })
    .notNull()
    .defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true })
    .notNull()
    .defaultNow(),
});
