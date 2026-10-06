// Clarly 2.0 S3: a tenant's widget configuration. `web_widgets` has no RLS
// (it is a resolution table, see migration 0072), so EVERY tenant-path query
// here filters on `tenant_id` explicitly — the spec asserts the predicate.
import { Injectable } from '@nestjs/common';
import { eq } from 'drizzle-orm';
import { randomInt } from 'node:crypto';
import { tenants, webWidgets } from '../persistence/drizzle/schema';
import { PersistenceService } from '../persistence/persistence.service';
import type { UpdateWidgetBody, WidgetConfigRecord } from './widget.dto';

const KEY_ALPHABET =
  'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';

export function generateWidgetKey(): string {
  let body = '';
  for (let i = 0; i < 24; i += 1)
    body += KEY_ALPHABET[randomInt(KEY_ALPHABET.length)];
  return `wk_${body}`;
}

type WidgetRow = typeof webWidgets.$inferSelect;

export function toWidgetRecord(row: WidgetRow): WidgetConfigRecord {
  return {
    id: row.id,
    publicKey: row.publicKey,
    enabled: row.enabled,
    allowedOrigins: row.allowedOrigins,
    title: row.title,
    welcomeMessage: row.welcomeMessage,
    accentColor: row.accentColor,
    position: row.position,
    locale: row.locale,
    updatedAt: row.updatedAt,
  };
}

export interface PublicWidget {
  row: WidgetRow;
  businessName: string;
}

@Injectable()
export class WidgetConfigService {
  constructor(private readonly persistence: PersistenceService) {}

  /** The tenant's widget, created (disabled, no origins) on first read so it always has a key to show. */
  async getOrCreate(tenantId: string): Promise<WidgetRow> {
    const [existing] = await this.persistence.runAdminQuery((db) =>
      db
        .select()
        .from(webWidgets)
        .where(eq(webWidgets.tenantId, tenantId))
        .limit(1),
    );
    if (existing) return existing;
    const [created] = await this.persistence.runAdminQuery((db) =>
      db
        .insert(webWidgets)
        .values({ tenantId, publicKey: generateWidgetKey() })
        .onConflictDoNothing({ target: webWidgets.tenantId })
        .returning(),
    );
    if (created) return created;
    // Lost a race with a concurrent first read: the other insert won.
    const [row] = await this.persistence.runAdminQuery((db) =>
      db
        .select()
        .from(webWidgets)
        .where(eq(webWidgets.tenantId, tenantId))
        .limit(1),
    );
    return row;
  }

  async update(tenantId: string, patch: UpdateWidgetBody): Promise<WidgetRow> {
    await this.getOrCreate(tenantId);
    const set = Object.fromEntries(
      Object.entries(patch).filter(([, v]) => v !== undefined),
    );
    const [row] = await this.persistence.runAdminQuery((db) =>
      db
        .update(webWidgets)
        .set({ ...set, updatedAt: new Date() })
        .where(eq(webWidgets.tenantId, tenantId))
        .returning(),
    );
    return row;
  }

  /** A new public key; the old snippet stops working at once. */
  async rotateKey(tenantId: string): Promise<WidgetRow> {
    await this.getOrCreate(tenantId);
    const [row] = await this.persistence.runAdminQuery((db) =>
      db
        .update(webWidgets)
        .set({ publicKey: generateWidgetKey(), updatedAt: new Date() })
        .where(eq(webWidgets.tenantId, tenantId))
        .returning(),
    );
    return row;
  }

  /** Public path: an ENABLED widget by its key, with the business name for the header. */
  async findEnabledByKey(publicKey: string): Promise<PublicWidget | null> {
    const [hit] = await this.persistence.runAdminQuery((db) =>
      db
        .select({
          row: webWidgets,
          businessName: tenants.name,
          closedAt: tenants.closedAt,
        })
        .from(webWidgets)
        .innerJoin(tenants, eq(tenants.id, webWidgets.tenantId))
        .where(eq(webWidgets.publicKey, publicKey))
        .limit(1),
    );
    if (!hit || !hit.row.enabled || hit.closedAt !== null) return null;
    return { row: hit.row, businessName: hit.businessName };
  }
}
