// Channel (WhatsappModule, T6): resolves a `phone_number_id` to that
// tenant's decrypted BSP credentials, for the outbound send path only.
//
// Deliberately a SEPARATE service from WebhookNumberResolutionService,
// which resolves the same column to a `tenant_id` and whose own header
// comment commits to "only ever selects tenantId, never the encrypted
// credentials column." That constraint is real and this service does not
// weaken it: the inbound path (untrusted bytes, no tenant context yet)
// still never touches credentials, while the outbound path (already past
// auth, already tenant-scoped, about to call the BSP) necessarily does.
// Two call sites with genuinely different trust levels, two services.
//
// Uses runAdminQuery() for the same reason the resolution service does —
// whatsapp_numbers has no RLS policy (see whatsapp-numbers.table.ts), so a
// withTenantTx() read here would not be enforcing anything extra, and the
// lookup key (phoneNumberId) is unique platform-wide.
import { Injectable } from '@nestjs/common';
import { eq } from 'drizzle-orm';
import { whatsappNumbers } from '../persistence/drizzle/schema';
import { PersistenceService } from '../persistence/persistence.service';
import { BspCredentialsEncryptionService } from './bsp-credentials-encryption.service';

/** Thrown when a send is attempted for a phone_number_id no tenant has connected. */
export class UnknownBspCredentialsError extends Error {
  constructor(phoneNumberId: string) {
    super(`No BSP credentials stored for phone_number_id ${phoneNumberId}.`);
    this.name = 'UnknownBspCredentialsError';
  }
}

/** Thrown when a row exists but its decrypted payload lacks the credential the bound adapter needs — a seeding/migration bug, surfaced rather than sent as `undefined` in an auth header. */
export class MalformedBspCredentialsError extends Error {
  constructor(phoneNumberId: string, key: string) {
    super(
      `Stored BSP credentials for phone_number_id ${phoneNumberId} have no usable "${key}".`,
    );
    this.name = 'MalformedBspCredentialsError';
  }
}

@Injectable()
export class BspCredentialsService {
  constructor(
    private readonly persistence: PersistenceService,
    private readonly encryption: BspCredentialsEncryptionService,
  ) {}

  /**
   * @param key which credential the bound adapter needs — `accessToken`
   *   for Meta's bearer token. The encrypted blob is a plain JSON object,
   *   so one row shape serves any provider; only the adapter knows which
   *   field it wants.
   */
  async getCredential(phoneNumberId: string, key: string): Promise<string> {
    const rows = await this.persistence.runAdminQuery((db) =>
      db
        .select({ encrypted: whatsappNumbers.bspCredentialsEncrypted })
        .from(whatsappNumbers)
        .where(eq(whatsappNumbers.phoneNumberId, phoneNumberId))
        .limit(1),
    );

    if (rows.length === 0) {
      throw new UnknownBspCredentialsError(phoneNumberId);
    }

    // decrypt() throws CredentialsDecryptionError on tamper/key-mismatch —
    // deliberately allowed to propagate rather than being remapped here.
    const decrypted = this.encryption.decrypt(rows[0].encrypted);
    const credential = decrypted[key];
    if (typeof credential !== 'string' || credential.length === 0) {
      throw new MalformedBspCredentialsError(phoneNumberId, key);
    }

    return credential;
  }
}
