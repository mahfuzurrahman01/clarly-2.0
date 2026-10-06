// Privacy (Gulf T7 / D7): Meta's Data Deletion Request and Deauthorize
// callbacks, plus the public deletion-status page. Meta will not let the app
// go Live without all three configured, so this gates Phase 4.
//
// Single responsibility: turn a verified Meta privacy event into the right
// change to data we hold. It owns only `meta_data_deletion_requests`; every
// change to `social_channels` goes through SocialChannelCredentialsService,
// which owns that table.
//
// Module-boundary notes:
//   - Imports MetaChannelModule for SocialChannelCredentialsService only.
//     Safe direction: MetaChannelModule imports nothing from here.
//   - Imports WhatsappModule for WhatsappNumberHealthStore only (Gulf T5:
//     deauthorize degrades WhatsApp numbers too). Same safe direction.
//   - Provides WebhookRateLimiterService directly rather than importing
//     WebhookModule for it — that module drags the whole respond path (agent,
//     conversation, outbound…) into a three-route privacy module. The
//     limiter is a stateless Redis counter; a second instance costs nothing.
//   - Raw DB access only through PersistenceService.runAdminQuery: nothing
//     here has a tenant context (see meta-data-deletion-requests.table.ts).
import { Module } from '@nestjs/common';
import { CoreModule } from '../core';
import { MetaChannelModule } from '../meta-channel/meta-channel.module';
import { PersistenceModule } from '../persistence/persistence.module';
import { QueueModule } from '../queue/queue.module';
import { WhatsappModule } from '../whatsapp/whatsapp.module';
import { WebhookRateLimiterService } from '../webhook/webhook-rate-limiter.service';
import { MetaDataDeletionService } from './meta-data-deletion.service';
import { MetaDeauthorizeService } from './meta-deauthorize.service';
import { MetaPrivacyController } from './meta-privacy.controller';
import { MetaSignedRequestVerifier } from './meta-signed-request-verifier.service';

export {
  InvalidSignedRequestError,
  parseMetaSignedRequest,
} from './meta-signed-request';

@Module({
  imports: [
    CoreModule,
    PersistenceModule,
    QueueModule,
    MetaChannelModule,
    WhatsappModule,
  ],
  controllers: [MetaPrivacyController],
  providers: [
    MetaSignedRequestVerifier,
    MetaDataDeletionService,
    MetaDeauthorizeService,
    WebhookRateLimiterService,
  ],
})
export class PrivacyModule {}
