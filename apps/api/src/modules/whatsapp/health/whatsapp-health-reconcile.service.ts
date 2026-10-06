// Channel (WhatsappModule, Gulf T5 / D5): the daily health reconcile. For
// every connected number, reads Meta's view (quality rating, messaging
// limit, display-name status, health_status, payment method) with the
// number's own token and stores it with `last_health_check_at`.
//
// It also corrects the connection state from what it read:
//   - token refused (401 / 190)   -> reconnect_required
//   - health_status BLOCKED       -> restricted, with Meta's description and
//                                    suggested fix as the reason
//   - AVAILABLE / LIMITED         -> a `restricted` number is restored to
//                                    active (the restriction has lifted).
//     reconnect_required and disconnected are never restored here: only a
//     new Embedded Signup (or ACCOUNT_RECONNECTED) clears those.
// This is also what backfills `waba_id` / `display_phone_number` on rows
// connected before T5, so their WABA webhooks start matching.
//
// Sequential and best-effort: one number failing is logged and counted,
// never aborts the sweep. Tokens are never logged.
import { Injectable } from '@nestjs/common';
import { AppLoggerService, Clock } from '../../core';
import { MetaGraphError } from '../../meta-graph/meta-graph.module';
import { BspCredentialsService } from '../bsp-credentials.service';
import {
  CONNECTION_REASONS,
  degrade,
  restore,
  type ConnectionTransition,
} from './connection-state.policy';
import { MetaPhoneNumberHealthReader } from './meta-phone-number-health.reader';
import {
  WhatsappNumberHealthStore,
  type ReconcileTarget,
  type WhatsappHealthSnapshot,
} from './whatsapp-number-health.store';

const CONTEXT = 'WhatsappHealthReconcileService';

export interface ReconcileSummary {
  /** Numbers whose health was read and stored. */
  checked: number;
  /** Numbers this sweep moved to `restricted`. */
  restricted: number;
  /** Numbers this sweep moved to `reconnect_required`. */
  reconnectRequired: number;
  /** Numbers that could not be read (Meta error, missing credentials). */
  failed: number;
}

export type TargetOutcome =
  'checked' | 'restricted' | 'reconnect_required' | 'failed';

@Injectable()
export class WhatsappHealthReconcileService {
  constructor(
    private readonly store: WhatsappNumberHealthStore,
    private readonly credentials: BspCredentialsService,
    private readonly reader: MetaPhoneNumberHealthReader,
    private readonly clock: Clock,
    private readonly logger: AppLoggerService,
  ) {}

  async reconcileAll(): Promise<ReconcileSummary> {
    const targets = await this.store.listReconcileTargets();
    const outcomes: TargetOutcome[] = [];
    for (const target of targets) {
      outcomes.push(await this.reconcileOne(target));
    }
    const count = (outcome: TargetOutcome) =>
      outcomes.filter((o) => o === outcome).length;
    return {
      checked: count('checked') + count('restricted'),
      restricted: count('restricted'),
      reconnectRequired: count('reconnect_required'),
      failed: count('failed'),
    };
  }

  /**
   * F19 (D4): the on-demand read `CampaignEligibilityService` triggers when a
   * number's snapshot is older than 24h. Deliberately the SAME code path as
   * the daily sweep — a second, campaign-only health read would be a second
   * definition of what "healthy" means.
   */
  reconcileNumber(target: ReconcileTarget): Promise<TargetOutcome> {
    return this.reconcileOne(target);
  }

  private async reconcileOne(target: ReconcileTarget): Promise<TargetOutcome> {
    const { phoneNumberId } = target;
    try {
      const accessToken = await this.credentials.getCredential(
        phoneNumberId,
        'accessToken',
      );
      const wabaId = await this.optionalWabaId(phoneNumberId);
      const snapshot = await this.reader.read(
        phoneNumberId,
        wabaId,
        accessToken,
        this.clock.now(),
      );
      await this.store.recordHealthCheck(phoneNumberId, snapshot, wabaId);

      const transition = stateFromHealth(snapshot);
      if (!transition) return 'checked';
      const affected = await this.store.transitionByPhoneNumberId(
        phoneNumberId,
        transition,
      );
      return affected.some((a) => a.connectionState === 'restricted')
        ? 'restricted'
        : 'checked';
    } catch (error) {
      if (error instanceof MetaGraphError && error.isAccessTokenRevoked) {
        await this.store.transitionByPhoneNumberId(
          phoneNumberId,
          degrade('reconnect_required', CONNECTION_REASONS.tokenRevoked),
        );
        this.logger.warn(
          `whatsapp health reconcile: token for number ${phoneNumberId} of tenant ${target.tenantId} was refused by Meta; marked reconnect_required`,
          CONTEXT,
        );
        return 'reconnect_required';
      }
      this.logger.warn(
        `whatsapp health reconcile: could not check number ${phoneNumberId} of tenant ${target.tenantId}: ${error instanceof Error ? error.message : String(error)}`,
        CONTEXT,
      );
      return 'failed';
    }
  }

  /** Rows connected before T3 may have no wabaId in their credentials; they are still checked, just without the WABA read. */
  private async optionalWabaId(phoneNumberId: string): Promise<string | null> {
    try {
      return await this.credentials.getCredential(phoneNumberId, 'wabaId');
    } catch {
      return null;
    }
  }
}

function stateFromHealth(
  snapshot: WhatsappHealthSnapshot,
): ConnectionTransition | null {
  if (snapshot.messagingHealth === 'BLOCKED') {
    return degrade('restricted', blockedReason(snapshot));
  }
  if (
    snapshot.messagingHealth === 'AVAILABLE' ||
    snapshot.messagingHealth === 'LIMITED'
  ) {
    return restore(['restricted']);
  }
  return null;
}

function blockedReason(snapshot: WhatsappHealthSnapshot): string {
  const issue = snapshot.healthIssues.find((i) => i.severity === 'BLOCKED');
  if (!issue) {
    return 'Meta is blocking messages from this number. Check it in WhatsApp Manager.';
  }
  const description = withFullStop(issue.description);
  const solution = issue.possibleSolution
    ? ` ${withFullStop(issue.possibleSolution)}`
    : '';
  return `Meta is blocking messages from this number: ${description}${solution}`;
}

function withFullStop(text: string): string {
  const trimmed = text.trim();
  return /[.!?]$/.test(trimmed) ? trimmed : `${trimmed}.`;
}
