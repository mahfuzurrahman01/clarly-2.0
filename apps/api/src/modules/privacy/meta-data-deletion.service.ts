// Privacy (PrivacyModule, Gulf T7 / D7): Meta's Data Deletion Request
// callback — a user asked Facebook to have us delete the data we hold about
// them — and the public status lookup Meta links them to.
//
// WHAT "their data" is, precisely. The callback names an app-scoped user id
// (ASID): the id of someone who logged in to OUR app with Facebook. In this
// product that is only ever a tenant admin who connected a page / Instagram
// account. What we hold keyed by that person:
//   - the long-lived user access token and the page tokens derived from it,
//     inside `social_channels.credentials_encrypted`;
//   - the link itself, `social_channels.connected_by_meta_user_hash`.
// Both are erased (SocialChannelCredentialsService.scrubCredentialsForMetaUser).
//
// Deliberately NOT deleted, and why:
//   - Customer records (`customers`, `conversations`, `messages`) keyed by a
//     Messenger PSID / Instagram IGSID. Those are PAGE-scoped ids, a
//     different id space from the ASID Meta sends here; no ASID ever equals
//     a PSID, so matching on it would delete nothing or — worse — the wrong
//     person. Those customers' data belongs to the tenant (the controller in
//     GDPR terms); their erasure goes through the tenant's own customer
//     deletion and the transcript-retention purge, not this callback.
//   - The channel row. The page belongs to the tenant's business; deleting
//     the row would silently stop routing its customers' messages. It is
//     degraded to `reconnect_required` with no token left in it.
//
// Inline, not a queue job. The whole deletion is one indexed UPDATE over the
// handful of rows one person connected — milliseconds, no Graph calls. A job
// would add a Redis dependency and a window where the status page says
// "pending" for no reason. If deletion ever grows slow work (e.g. object
// storage), that part moves to a job and this row stays `pending` until it
// finishes; the status contract already allows for it.
//
// Idempotency. The row is keyed on a hash of the exact signed_request, so a
// re-delivery of the same request returns the same confirmation code; a
// fresh request for the same user gets a new code and re-runs a deletion
// that is itself idempotent (it finds nothing the second time). A `failed`
// row is re-run on re-delivery.
import { createHash, randomBytes } from 'node:crypto';
import { Injectable } from '@nestjs/common';
import { eq } from 'drizzle-orm';
import { AppLoggerService } from '../core';
import { hashMetaUserId } from '../meta-graph/meta-user-id-hash';
import { SocialChannelCredentialsService } from '../meta-channel/social-channel-credentials.service';
import {
  metaDataDeletionRequests,
  type MetaDataDeletionStatus,
} from '../persistence/drizzle/schema';
import { PersistenceService } from '../persistence/persistence.service';
import type { MetaSignedRequest } from './meta-signed-request';

export const DATA_DELETED_REASON =
  'The Facebook user who connected this channel asked Meta to delete their data, so the stored access tokens were erased. Reconnect the channel to continue replying.';

/** 128 bits, hex. The ONLY key the public status page accepts, so it must be unguessable. */
const CONFIRMATION_CODE_BYTES = 16;
const CONFIRMATION_CODE_FORMAT = /^[0-9a-f]{32}$/;

export interface DeletionRequestResult {
  confirmationCode: string;
  status: MetaDataDeletionStatus;
}

/** Everything the public status page may reveal — nothing that identifies anyone. */
export interface DeletionRequestStatus {
  confirmationCode: string;
  status: MetaDataDeletionStatus;
  requestedAt: Date;
  completedAt: Date | null;
}

@Injectable()
export class MetaDataDeletionService {
  constructor(
    private readonly persistence: PersistenceService,
    private readonly socialChannels: SocialChannelCredentialsService,
    private readonly logger: AppLoggerService,
  ) {}

  /**
   * Records the request and performs the deletion. Never throws for a
   * deletion failure — the row says `failed` and on-call is paged via the
   * error log — because Meta still needs a confirmation code to show the
   * user, and the status page then says honestly what happened.
   */
  async request(
    signedRequest: string,
    parsed: MetaSignedRequest,
  ): Promise<DeletionRequestResult> {
    const row = await this.findOrCreate(signedRequest, parsed);
    if (row.status === 'completed') {
      return { confirmationCode: row.confirmationCode, status: row.status };
    }

    try {
      const scrubbed = await this.socialChannels.scrubCredentialsForMetaUser(
        parsed.userId,
        DATA_DELETED_REASON,
      );
      await this.finish(row.id, {
        status: 'completed',
        socialChannelsScrubbed: scrubbed.length,
        error: null,
        completedAt: new Date(),
      });
      this.logger.log(
        `meta data deletion ${row.confirmationCode} completed: ${scrubbed.length} social channel credential set(s) erased (tenants: ${
          [...new Set(scrubbed.map((c) => c.tenantId))].join(', ') || 'none'
        })`,
        MetaDataDeletionService.name,
      );
      return { confirmationCode: row.confirmationCode, status: 'completed' };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      await this.finish(row.id, {
        status: 'failed',
        socialChannelsScrubbed: 0,
        error: message.slice(0, 1000),
        completedAt: null,
      });
      this.logger.error(
        `meta data deletion ${row.confirmationCode} FAILED — a user's data-deletion request is not honoured until this is re-run: ${message}`,
        error instanceof Error ? error.stack : undefined,
        MetaDataDeletionService.name,
      );
      return { confirmationCode: row.confirmationCode, status: 'failed' };
    }
  }

  /** @returns null for an unknown or malformed code — the caller 404s both alike. */
  async status(
    confirmationCode: string,
  ): Promise<DeletionRequestStatus | null> {
    if (!CONFIRMATION_CODE_FORMAT.test(confirmationCode)) return null;

    const rows = await this.persistence.runAdminQuery((db) =>
      db
        .select({
          confirmationCode: metaDataDeletionRequests.confirmationCode,
          status: metaDataDeletionRequests.status,
          requestedAt: metaDataDeletionRequests.requestedAt,
          completedAt: metaDataDeletionRequests.completedAt,
        })
        .from(metaDataDeletionRequests)
        .where(eq(metaDataDeletionRequests.confirmationCode, confirmationCode))
        .limit(1),
    );
    return rows[0] ?? null;
  }

  private async findOrCreate(
    signedRequest: string,
    parsed: MetaSignedRequest,
  ): Promise<{
    id: string;
    confirmationCode: string;
    status: MetaDataDeletionStatus;
  }> {
    const signedRequestHash = createHash('sha256')
      .update(signedRequest)
      .digest('hex');

    // ON CONFLICT DO NOTHING + re-read, rather than read-then-insert: two
    // concurrent deliveries of the same request must converge on one row.
    await this.persistence.runAdminQuery((db) =>
      db
        .insert(metaDataDeletionRequests)
        .values({
          confirmationCode: randomBytes(CONFIRMATION_CODE_BYTES).toString(
            'hex',
          ),
          metaUserIdHash: hashMetaUserId(parsed.userId),
          signedRequestHash,
          status: 'pending',
        })
        .onConflictDoNothing({
          target: metaDataDeletionRequests.signedRequestHash,
        }),
    );

    const rows = await this.persistence.runAdminQuery((db) =>
      db
        .select({
          id: metaDataDeletionRequests.id,
          confirmationCode: metaDataDeletionRequests.confirmationCode,
          status: metaDataDeletionRequests.status,
        })
        .from(metaDataDeletionRequests)
        .where(
          eq(metaDataDeletionRequests.signedRequestHash, signedRequestHash),
        )
        .limit(1),
    );
    if (rows.length === 0) {
      throw new Error(
        'meta data deletion request row vanished between insert and read',
      );
    }
    return rows[0];
  }

  private async finish(
    id: string,
    values: {
      status: MetaDataDeletionStatus;
      socialChannelsScrubbed: number;
      error: string | null;
      completedAt: Date | null;
    },
  ): Promise<void> {
    await this.persistence.runAdminQuery((db) =>
      db
        .update(metaDataDeletionRequests)
        .set(values)
        .where(eq(metaDataDeletionRequests.id, id)),
    );
  }
}
