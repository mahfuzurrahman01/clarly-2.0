// Channel/connect (WhatsappModule): the
// WRITE half of `whatsapp_numbers`, deliberately kept out of
// WhatsappNumberDirectory — that service's own header comment commits it
// to being a read-only directory ("read access to a tenant's own
// numbers"), the same way BspCredentialsService is a separate,
// read-only-for-sending service from WebhookNumberResolutionService.
// Reuses BspCredentialsEncryptionService directly rather than
// re-implementing AES-256-GCM encryption — the "encrypted credential
// insert pattern" this task's brief points at IS that service; this file
// is what was missing (an INSERT/UPDATE call site for it), not a second
// encryption implementation.
//
// Every write goes through TenantContextService.withTenantTx() for
// defense in depth, exactly as whatsapp-numbers.table.ts's own header
// comment recommends for any read/write past the initial webhook-routing
// lookup — even though this table has no RLS policy of its own.
import { Injectable } from '@nestjs/common';
import { and, eq, ne } from 'drizzle-orm';
import { hashMetaUserId } from '../../meta-graph/meta-user-id-hash';
import { whatsappNumbers } from '../../persistence/drizzle/schema';
import { TenantContextService } from '../../tenant-context/tenant-context.service';
import { BspCredentialsEncryptionService } from '../bsp-credentials-encryption.service';
import type { ConnectionStatus } from '../health/connection-state.policy';

export interface ConnectedNumber {
  id: string;
  phoneNumberId: string;
}

/** Gulf T3 (D5 enum): the state a connect writes alongside the credentials. One definition, shared with the health writers. */
export type { ConnectionStatus } from '../health/connection-state.policy';

/**
 * Gulf T5 (D5): plaintext facts about the number, stored next to the
 * credentials so WABA webhooks (keyed by WABA id / display number) and the
 * deauthorize callback (keyed by Meta user) can find the row. Omitted
 * fields are left as they are on a reconnect.
 */
export interface ConnectedNumberProfile {
  wabaId?: string | null;
  /** Digits only. */
  displayPhoneNumber?: string | null;
  /** Stored only as hashMetaUserId(); never in plaintext. */
  connectedByMetaUserId?: string | null;
}

export type StoredConnection = ConnectedNumber & ConnectionStatus;

const ACTIVE: ConnectionStatus = {
  connectionState: 'active',
  connectionError: null,
};

/** Thrown when a `phone_number_id` the provider handed back is already connected to a DIFFERENT tenant — a cross-tenant hijack attempt or a stale/reused test number, never silently reassigned. */
export class ChannelOwnedByAnotherTenantError extends Error {
  constructor(phoneNumberId: string) {
    super(
      `phone_number_id ${phoneNumberId} is already connected to a different tenant.`,
    );
    this.name = 'ChannelOwnedByAnotherTenantError';
  }
}

/** Thrown when a re-generate/lookup targets a whatsapp_numbers row that either doesn't exist or belongs to another tenant — same 404-shaped semantics as UnknownWhatsappNumberError elsewhere in WebhookModule, kept local rather than imported to avoid a cross-module coupling for one error class. */
export class UnknownConnectedNumberError extends Error {
  constructor(id: string) {
    super(`No connected WhatsApp number ${id} for this tenant.`);
    this.name = 'UnknownConnectedNumberError';
  }
}

@Injectable()
export class WhatsappConnectionService {
  constructor(
    private readonly tenantContext: TenantContextService,
    private readonly encryption: BspCredentialsEncryptionService,
  ) {}

  /**
   * Upserts a connected channel: first connect inserts, a re-run of the
   * same channel_id (e.g. a retried connect) updates in place instead of
   * violating whatsapp_numbers' unique(phone_number_id) constraint. The
   * `where` clause on the conflict update is the hijack guard: if
   * phone_number_id already belongs to a DIFFERENT tenant, the update is
   * skipped by Postgres and `.returning()` comes back empty, which this
   * method turns into a thrown error rather than a silent no-op.
   *
   * `status` (Gulf T3) is written on insert AND on the conflict update, so a
   * reconnect that succeeds clears an earlier `reconnect_required`, and one
   * that fails never leaves a stale `active` behind.
   */
  async connectNumber(
    tenantId: string,
    phoneNumberId: string,
    credentials: Record<string, unknown>,
    status: ConnectionStatus = ACTIVE,
    profile: ConnectedNumberProfile = {},
  ): Promise<StoredConnection> {
    const encrypted = this.encryption.encrypt(credentials);
    const profileColumns = toProfileColumns(profile);

    const rows = await this.tenantContext.withTenantTx(
      (tx) =>
        tx
          .insert(whatsappNumbers)
          .values({
            tenantId,
            phoneNumberId,
            bspCredentialsEncrypted: encrypted,
            connectionState: status.connectionState,
            connectionError: status.connectionError,
            ...profileColumns,
          })
          .onConflictDoUpdate({
            target: whatsappNumbers.phoneNumberId,
            set: {
              bspCredentialsEncrypted: encrypted,
              connectionState: status.connectionState,
              connectionError: status.connectionError,
              ...profileColumns,
              updatedAt: new Date(),
            },
            where: eq(whatsappNumbers.tenantId, tenantId),
          })
          .returning({
            id: whatsappNumbers.id,
            phoneNumberId: whatsappNumbers.phoneNumberId,
            connectionState: whatsappNumbers.connectionState,
            connectionError: whatsappNumbers.connectionError,
          }),
      tenantId,
    );

    const row = rows[0];
    if (!row) {
      throw new ChannelOwnedByAnotherTenantError(phoneNumberId);
    }
    return row;
  }

  /**
   * Gulf T3: the hijack guard's early half. True when `phoneNumberId` is
   * already connected to a tenant OTHER than `tenantId`. ConnectService asks
   * this before any Graph write (subscribe/register), so a refused connect
   * never re-registers another workspace's number. `connectNumber`'s ON
   * CONFLICT guard stays the authority for the race between the two.
   */
  async isConnectedToAnotherTenant(
    tenantId: string,
    phoneNumberId: string,
  ): Promise<boolean> {
    const rows = await this.tenantContext.withTenantTx(
      (tx) =>
        tx
          .select({ id: whatsappNumbers.id })
          .from(whatsappNumbers)
          .where(
            and(
              eq(whatsappNumbers.phoneNumberId, phoneNumberId),
              ne(whatsappNumbers.tenantId, tenantId),
            ),
          )
          .limit(1),
      tenantId,
    );
    return rows.length > 0;
  }

  /**
   * Gulf T3 (D15c): the two-step verification PIN stored with THIS tenant's
   * row for `phoneNumberId`, or null. A reconnect re-registers with the PIN
   * the number already has instead of minting a new one that Meta would
   * refuse as a mismatch. Never reads another tenant's row.
   */
  async getStoredPin(
    tenantId: string,
    phoneNumberId: string,
  ): Promise<string | null> {
    const rows = await this.tenantContext.withTenantTx(
      (tx) =>
        tx
          .select({ encrypted: whatsappNumbers.bspCredentialsEncrypted })
          .from(whatsappNumbers)
          .where(
            and(
              eq(whatsappNumbers.phoneNumberId, phoneNumberId),
              eq(whatsappNumbers.tenantId, tenantId),
            ),
          )
          .limit(1),
      tenantId,
    );
    const row = rows[0];
    if (!row) return null;
    const pin = this.encryption.decrypt(row.encrypted).pin;
    return typeof pin === 'string' && /^\d{6}$/.test(pin) ? pin : null;
  }

  /** Tenant-scoped lookup used before re-generation — callers must never touch credentials for a number they don't own. */
  async getOwnedNumber(
    tenantId: string,
    numberId: string,
  ): Promise<ConnectedNumber> {
    const rows = await this.tenantContext.withTenantTx(
      (tx) =>
        tx
          .select({
            id: whatsappNumbers.id,
            phoneNumberId: whatsappNumbers.phoneNumberId,
          })
          .from(whatsappNumbers)
          .where(
            and(
              eq(whatsappNumbers.id, numberId),
              eq(whatsappNumbers.tenantId, tenantId),
            ),
          )
          .limit(1),
      tenantId,
    );

    const row = rows[0];
    if (!row) {
      throw new UnknownConnectedNumberError(numberId);
    }
    return row;
  }

  async replaceCredentials(
    tenantId: string,
    numberId: string,
    credentials: Record<string, unknown>,
  ): Promise<ConnectedNumber> {
    const encrypted = this.encryption.encrypt(credentials);

    const rows = await this.tenantContext.withTenantTx(
      (tx) =>
        tx
          .update(whatsappNumbers)
          .set({ bspCredentialsEncrypted: encrypted, updatedAt: new Date() })
          .where(
            and(
              eq(whatsappNumbers.id, numberId),
              eq(whatsappNumbers.tenantId, tenantId),
            ),
          )
          .returning({
            id: whatsappNumbers.id,
            phoneNumberId: whatsappNumbers.phoneNumberId,
          }),
      tenantId,
    );

    const row = rows[0];
    if (!row) {
      throw new UnknownConnectedNumberError(numberId);
    }
    return row;
  }
}

/** Only the profile fields the caller actually supplied become columns, so a reconnect never nulls what it did not learn. */
function toProfileColumns(profile: ConnectedNumberProfile): {
  wabaId?: string | null;
  displayPhoneNumber?: string | null;
  connectedByMetaUserHash?: string | null;
} {
  return {
    ...(profile.wabaId !== undefined ? { wabaId: profile.wabaId } : {}),
    ...(profile.displayPhoneNumber !== undefined
      ? { displayPhoneNumber: profile.displayPhoneNumber }
      : {}),
    ...(profile.connectedByMetaUserId
      ? {
          connectedByMetaUserHash: hashMetaUserId(
            profile.connectedByMetaUserId,
          ),
        }
      : {}),
  };
}
