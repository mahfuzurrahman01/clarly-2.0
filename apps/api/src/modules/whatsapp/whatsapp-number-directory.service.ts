// Channel (WhatsappModule): read access to a tenant's own numbers.
//
// `whatsapp_numbers` carries no row-level security — it is read during
// webhook routing before a tenant is known — so every read here filters by
// tenant explicitly. That filter is the isolation boundary, not decoration.
// Credentials are never selected.
import { Injectable } from '@nestjs/common';
import { eq } from 'drizzle-orm';
import { whatsappNumbers } from '../persistence/drizzle/schema';
import { TenantContextService } from '../tenant-context/tenant-context.service';
import type { ConnectedNumber } from './connect/connect.dto';

@Injectable()
export class WhatsappNumberDirectory {
  constructor(private readonly tenantContext: TenantContextService) {}

  /** Gulf T3 state + Gulf T5 (D5) health, in the ConnectedNumber read shape. */
  async listForTenant(tenantId: string): Promise<ConnectedNumber[]> {
    const rows = await this.tenantContext.withTenantTx(
      (tx) =>
        tx
          .select({
            id: whatsappNumbers.id,
            phoneNumberId: whatsappNumbers.phoneNumberId,
            connectionState: whatsappNumbers.connectionState,
            connectionError: whatsappNumbers.connectionError,
            displayPhoneNumber: whatsappNumbers.displayPhoneNumber,
            verifiedName: whatsappNumbers.verifiedName,
            qualityRating: whatsappNumbers.qualityRating,
            messagingLimitTier: whatsappNumbers.messagingLimitTier,
            nameStatus: whatsappNumbers.nameStatus,
            paymentMethodAttached: whatsappNumbers.paymentMethodAttached,
            messagingHealth: whatsappNumbers.messagingHealth,
            healthIssues: whatsappNumbers.healthIssues,
            lastHealthCheckAt: whatsappNumbers.lastHealthCheckAt,
          })
          .from(whatsappNumbers)
          .where(eq(whatsappNumbers.tenantId, tenantId))
          .orderBy(whatsappNumbers.createdAt),
      tenantId,
    );
    return rows.map((row) => ({
      ...row,
      lastHealthCheckAt: row.lastHealthCheckAt?.toISOString() ?? null,
    }));
  }

  /**
   * F19 (D2): which WABA each of the tenant's numbers belongs to.
   *
   * Kept separate from `listForTenant` rather than widened into it: the WABA
   * id is not part of the console's ConnectedNumber contract, and
   * TemplateSyncService needs only this pair to stamp a synced template with
   * the account that reported it. Null `wabaId` for a row connected before
   * T5 and not yet reconciled — the caller must treat that as "unknown".
   */
  async wabaIdsByPhoneNumber(
    tenantId: string,
  ): Promise<Map<string, string | null>> {
    const rows = await this.tenantContext.withTenantTx(
      (tx) =>
        tx
          .select({
            phoneNumberId: whatsappNumbers.phoneNumberId,
            wabaId: whatsappNumbers.wabaId,
          })
          .from(whatsappNumbers)
          .where(eq(whatsappNumbers.tenantId, tenantId)),
      tenantId,
    );
    return new Map(rows.map((row) => [row.phoneNumberId, row.wabaId]));
  }
}
