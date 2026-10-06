// Privacy (PrivacyModule, Gulf T7 / D7): Meta's Deauthorize callback — a
// user removed our app in Facebook, so every token their login granted is
// dead from this moment.
//
// What that means per channel type:
//   - Messenger / Instagram (`social_channels`): every row that user
//     connected goes to `reconnect_required`, across every tenant, and no
//     other row is touched. The console's existing reconnect banner reads
//     that state; the send path already turns it into a human escalation
//     instead of a dropped message (MetaTokenService.ensureFreshToken).
//   - WhatsApp (`whatsapp_numbers`, Gulf T5): every number whose Embedded
//     Signup token belongs to that Meta user (`connected_by_meta_user_hash`,
//     from debug_token's user_id) goes to `reconnect_required`, through the
//     shared connection-state policy (a more severe state is kept). Rows
//     connected before T5 have no user recorded; for them the send path's
//     401/190 handling and the daily reconcile are what notice a dead token.
//     A business removing the app in Business Settings is also reported as
//     an `account_update` PARTNER_APP_UNINSTALLED webhook, handled in
//     WhatsappModule.
//
// Audit: not written to `audit_log`. That table is tenant-scoped, actor =
// a Supabase user, and written only by AuditInterceptor by design (see
// audit-log.service.ts) — it has no notion of a system actor. The structured
// log line below is the record; the per-channel `connection_error` is what
// the tenant sees.
import { Injectable } from '@nestjs/common';
import { AppLoggerService } from '../core';
import { SocialChannelCredentialsService } from '../meta-channel/social-channel-credentials.service';
import {
  CONNECTION_REASONS,
  WhatsappNumberHealthStore,
  degrade,
} from '../whatsapp/whatsapp.module';
import type { MetaSignedRequest } from './meta-signed-request';

export const DEAUTHORIZED_REASON =
  'The Facebook user who connected this channel removed this app from their Facebook account, so its access token no longer works. Reconnect the channel to continue replying.';

export interface DeauthorizeOutcome {
  socialChannelsDegraded: number;
  /** Gulf T5. */
  whatsappNumbersDegraded: number;
}

@Injectable()
export class MetaDeauthorizeService {
  constructor(
    private readonly socialChannels: SocialChannelCredentialsService,
    private readonly whatsappHealth: WhatsappNumberHealthStore,
    private readonly logger: AppLoggerService,
  ) {}

  async handle(request: MetaSignedRequest): Promise<DeauthorizeOutcome> {
    const affected = await this.socialChannels.markReconnectRequiredForMetaUser(
      request.userId,
      DEAUTHORIZED_REASON,
    );

    for (const channel of affected) {
      // warn, one line per tenant-visible degradation: this is the line an
      // on-call person greps for when a tenant asks why replies stopped.
      this.logger.warn(
        `meta deauthorize: channel ${channel.channelAccountId} of tenant ${channel.tenantId} degraded to reconnect_required`,
        MetaDeauthorizeService.name,
      );
    }

    const numbers = await this.whatsappHealth.transitionByMetaUser(
      request.userId,
      degrade('reconnect_required', CONNECTION_REASONS.deauthorized),
    );
    for (const number of numbers) {
      this.logger.warn(
        `meta deauthorize: WhatsApp number ${number.phoneNumberId} of tenant ${number.tenantId} degraded to reconnect_required`,
        MetaDeauthorizeService.name,
      );
    }

    // The user id is deliberately not logged — only whether anything matched.
    this.logger.log(
      `meta deauthorize processed: ${affected.length} social channel(s), ${numbers.length} WhatsApp number(s) degraded`,
      MetaDeauthorizeService.name,
    );

    return {
      socialChannelsDegraded: affected.length,
      whatsappNumbersDegraded: numbers.length,
    };
  }
}
