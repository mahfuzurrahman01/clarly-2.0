// Clarly 2.0 S3: `web` channel tenant resolution — widget id → tenant. Same
// shape and the same pre-tenant `runAdminQuery` as
// WhatsappNumberResolutionService, for the same reason (see migration 0072).
import { Injectable } from '@nestjs/common';
import { eq } from 'drizzle-orm';
import { webWidgets } from '../persistence/drizzle/schema';
import { PersistenceService } from '../persistence/persistence.service';

export class UnknownWebWidgetError extends Error {
  constructor() {
    super('No enabled website widget with this id.');
    this.name = 'UnknownWebWidgetError';
  }
}

@Injectable()
export class WebWidgetResolutionService {
  constructor(private readonly persistence: PersistenceService) {}

  /** @throws UnknownWebWidgetError for an unknown or disabled widget. */
  async resolveTenantId(widgetId: string): Promise<string> {
    const rows = await this.persistence.runAdminQuery((db) =>
      db
        .select({ tenantId: webWidgets.tenantId, enabled: webWidgets.enabled })
        .from(webWidgets)
        .where(eq(webWidgets.id, widgetId))
        .limit(1),
    );
    const row = rows[0];
    if (!row || !row.enabled) throw new UnknownWebWidgetError();
    return row.tenantId;
  }
}
