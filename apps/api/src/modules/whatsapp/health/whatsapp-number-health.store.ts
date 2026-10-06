// Channel (WhatsappModule, Gulf T5 / D5): the health half of
// `whatsapp_numbers` — connection-state transitions and Meta's health
// fields. The only writer of those columns after connect time.
//
// Every caller arrives WITHOUT a tenant context (a WABA webhook, the send
// path's credential lookup, Meta's deauthorize callback, the platform-wide
// reconcile sweep), and the lookup keys (waba id, phone_number_id, Meta user
// hash) are platform-unique, so this uses PersistenceService.runAdminQuery
// exactly like BspCredentialsService / WhatsappNumberResolutionService. It
// never selects or writes credentials.
//
// Transitions are read-then-conditional-write: the UPDATE only lands if the
// row is still in the state the policy decided from, so two concurrent
// writers (a webhook and a failed send) cannot interleave into a state the
// policy would not have produced. A lost race is simply "not affected".
import { Injectable } from '@nestjs/common';
import { and, eq, isNull, type SQL } from 'drizzle-orm';
import { hashMetaUserId } from '../../meta-graph/meta-user-id-hash';
import {
  whatsappNumbers,
  type WhatsappConnectionState,
  type WhatsappHealthIssue,
} from '../../persistence/drizzle/schema';
import { PersistenceService } from '../../persistence/persistence.service';
import {
  applyTransition,
  type ConnectionTransition,
} from './connection-state.policy';

/** A number whose connection state a transition actually changed. */
export interface AffectedWhatsappNumber {
  tenantId: string;
  phoneNumberId: string;
  connectionState: WhatsappConnectionState;
}

/** A number the reconcile sweep reads from Meta. */
export interface ReconcileTarget {
  tenantId: string;
  phoneNumberId: string;
}

/** What one successful Graph health read says about a number. */
export interface WhatsappHealthSnapshot {
  qualityRating: string | null;
  messagingLimitTier: string | null;
  nameStatus: string | null;
  messagingHealth: string | null;
  healthIssues: WhatsappHealthIssue[];
  displayPhoneNumber: string | null;
  verifiedName: string | null;
  /** Null when the WABA could not be read (unknown), never guessed. */
  paymentMethodAttached: boolean | null;
  /** F19 (D4): Meta's WABA `account_review_status` — APPROVED | PENDING | REJECTED. Null when the WABA read failed. */
  wabaAccountReviewStatus: string | null;
  /** F19 (D4): Meta's `owner_business_info.verification_status` — verified | not_verified | pending | failed. Null when the WABA read failed. */
  businessVerificationStatus: string | null;
  checkedAt: Date;
}

@Injectable()
export class WhatsappNumberHealthStore {
  constructor(private readonly persistence: PersistenceService) {}

  transitionByWaba(
    wabaId: string,
    transition: ConnectionTransition,
  ): Promise<AffectedWhatsappNumber[]> {
    return this.transitionWhere(eq(whatsappNumbers.wabaId, wabaId), transition);
  }

  transitionByPhoneNumberId(
    phoneNumberId: string,
    transition: ConnectionTransition,
  ): Promise<AffectedWhatsappNumber[]> {
    return this.transitionWhere(
      eq(whatsappNumbers.phoneNumberId, phoneNumberId),
      transition,
    );
  }

  /** Gulf T7 hook: every number connected by this Meta user, across tenants. The id is only ever compared hashed. */
  transitionByMetaUser(
    metaUserId: string,
    transition: ConnectionTransition,
  ): Promise<AffectedWhatsappNumber[]> {
    return this.transitionWhere(
      eq(whatsappNumbers.connectedByMetaUserHash, hashMetaUserId(metaUserId)),
      transition,
    );
  }

  /** Meta's messaging limit is per business portfolio, so every number on the WABA gets it. Returns rows updated. */
  async setMessagingLimitForWaba(
    wabaId: string,
    tier: string,
  ): Promise<number> {
    const rows = await this.persistence.runAdminQuery((db) =>
      db
        .update(whatsappNumbers)
        .set({ messagingLimitTier: tier, updatedAt: new Date() })
        .where(eq(whatsappNumbers.wabaId, wabaId))
        .returning({ id: whatsappNumbers.id }),
    );
    return rows.length;
  }

  /** The name webhook names the WABA + display number; both must match. Returns rows updated. */
  async setNameStatus(
    wabaId: string,
    displayPhoneNumber: string,
    nameStatus: string,
  ): Promise<number> {
    const rows = await this.persistence.runAdminQuery((db) =>
      db
        .update(whatsappNumbers)
        .set({ nameStatus, updatedAt: new Date() })
        .where(
          and(
            eq(whatsappNumbers.wabaId, wabaId),
            eq(whatsappNumbers.displayPhoneNumber, displayPhoneNumber),
          ),
        )
        .returning({ id: whatsappNumbers.id }),
    );
    return rows.length;
  }

  async listReconcileTargets(): Promise<ReconcileTarget[]> {
    return this.persistence.runAdminQuery((db) =>
      db
        .select({
          tenantId: whatsappNumbers.tenantId,
          phoneNumberId: whatsappNumbers.phoneNumberId,
        })
        .from(whatsappNumbers)
        .orderBy(whatsappNumbers.phoneNumberId),
    );
  }

  /**
   * Stores one successful health read. `wabaId` fills the column only where
   * it is still null (rows connected before T5); a stored value is never
   * overwritten from the credentials blob.
   */
  async recordHealthCheck(
    phoneNumberId: string,
    snapshot: WhatsappHealthSnapshot,
    wabaId: string | null,
  ): Promise<void> {
    await this.persistence.runAdminQuery(async (db) => {
      await db
        .update(whatsappNumbers)
        .set({
          qualityRating: snapshot.qualityRating,
          messagingLimitTier: snapshot.messagingLimitTier,
          nameStatus: snapshot.nameStatus,
          messagingHealth: snapshot.messagingHealth,
          healthIssues: snapshot.healthIssues,
          verifiedName: snapshot.verifiedName,
          paymentMethodAttached: snapshot.paymentMethodAttached,
          wabaAccountReviewStatus: snapshot.wabaAccountReviewStatus,
          businessVerificationStatus: snapshot.businessVerificationStatus,
          ...(snapshot.displayPhoneNumber
            ? { displayPhoneNumber: snapshot.displayPhoneNumber }
            : {}),
          lastHealthCheckAt: snapshot.checkedAt,
          updatedAt: new Date(),
        })
        .where(eq(whatsappNumbers.phoneNumberId, phoneNumberId));
      if (wabaId) {
        await db
          .update(whatsappNumbers)
          .set({ wabaId })
          .where(
            and(
              eq(whatsappNumbers.phoneNumberId, phoneNumberId),
              isNull(whatsappNumbers.wabaId),
            ),
          );
      }
    });
  }

  private async transitionWhere(
    condition: SQL,
    transition: ConnectionTransition,
  ): Promise<AffectedWhatsappNumber[]> {
    return this.persistence.runAdminQuery(async (db) => {
      const rows = await db
        .select({
          id: whatsappNumbers.id,
          tenantId: whatsappNumbers.tenantId,
          phoneNumberId: whatsappNumbers.phoneNumberId,
          connectionState: whatsappNumbers.connectionState,
          connectionError: whatsappNumbers.connectionError,
        })
        .from(whatsappNumbers)
        .where(condition);

      const affected: AffectedWhatsappNumber[] = [];
      for (const row of rows) {
        const next = applyTransition(row, transition);
        if (!next) continue;
        const updated = await db
          .update(whatsappNumbers)
          .set({ ...next, updatedAt: new Date() })
          .where(
            and(
              eq(whatsappNumbers.id, row.id),
              eq(whatsappNumbers.connectionState, row.connectionState),
            ),
          )
          .returning({ id: whatsappNumbers.id });
        if (updated.length > 0) {
          affected.push({
            tenantId: row.tenantId,
            phoneNumberId: row.phoneNumberId,
            connectionState: next.connectionState,
          });
        }
      }
      return affected;
    });
  }
}
