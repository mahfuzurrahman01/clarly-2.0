// Channel (WebhookModule, T6): resolves an inbound webhook's
// `phone_number_id` to a `tenant_id` — the FIRST thing that happens to any
// inbound webhook, before dedup, before rate limiting, before anything
// tenant-scoped. Uses PersistenceService.runAdminQuery(), not
// withTenantTx(), because there is no tenant context yet — resolving one
// IS the point of this lookup (see whatsapp-numbers.table.ts). Only ever
// selects `tenantId`, never the encrypted credentials column, from this
// admin-query path.
import { Injectable } from '@nestjs/common';
import { eq } from 'drizzle-orm';
import { whatsappNumbers } from '../persistence/drizzle/schema';
import { PersistenceService } from '../persistence/persistence.service';
import { UnknownWhatsappNumberError } from './unknown-whatsapp-number.error';

@Injectable()
export class WhatsappNumberResolutionService {
  constructor(private readonly persistence: PersistenceService) {}

  /** @throws UnknownWhatsappNumberError if no tenant is connected to this phone_number_id. */
  async resolveTenantId(phoneNumberId: string): Promise<string> {
    const rows = await this.persistence.runAdminQuery((db) =>
      db
        .select({ tenantId: whatsappNumbers.tenantId })
        .from(whatsappNumbers)
        .where(eq(whatsappNumbers.phoneNumberId, phoneNumberId))
        .limit(1),
    );

    if (rows.length === 0) {
      throw new UnknownWhatsappNumberError();
    }

    return rows[0].tenantId;
  }
}
