// Channel/connect (WhatsappModule): the WhatsApp connect surface. A sibling
// of WhatsappModule rather than a merge into it: WhatsappModule owns the
// BspAdapter port and the runtime send path, this owns tenant onboarding of
// numbers. They share only WhatsappNumberDirectory /
// BspCredentialsEncryptionService (both exported by WhatsappModule).
//
// Gulf T3 (D3): Meta Embedded Signup.
//   - ConnectService: numbers listing + completeEmbeddedSignup().
//   - EmbeddedSignupPort -> MetaEmbeddedSignupAdapter (Graph via the shared
//     MetaGraphClient, D8).
//   - WhatsappConnectionService: encrypted upsert with the ON CONFLICT
//     cross-tenant hijack guard.
//   - ConnectStateService: signed, tenant-bound, expiring CSRF state. Not
//     used by Embedded Signup (a bearer-authenticated JSON POST, whose ids
//     are verified server-side against the exchanged token); kept for any
//     future redirect-based connect flow.
// D16: the D7 card-before-connect gate (SubscriptionStatusPort) is gone.
import { MiddlewareConsumer, Module, type NestModule } from '@nestjs/common';
import { CoreModule } from '../../core';
import { AuthModule } from '../../auth/auth.module';
import { TenantAuthMiddleware } from '../../auth/tenant-auth.middleware';
import { BillingModule } from '../../billing/billing.module';
import { MetaGraphModule } from '../../meta-graph/meta-graph.module';
import { TenantContextModule } from '../../tenant-context/tenant-context.module';
import { WhatsappModule } from '../whatsapp.module';
import { ConnectController } from './connect.controller';
import { ConnectService } from './connect.service';
import { ConnectStateService } from './connect-state.service';
import { MetaEmbeddedSignupAdapter } from './meta-embedded-signup.adapter';
import { EmbeddedSignupPort } from './ports/embedded-signup.port';
import { WhatsappConnectionService } from './whatsapp-connection.service';

export * from './connect.dto';
export { ConnectService } from './connect.service';
export { ConnectStateService } from './connect-state.service';
export { WhatsappConnectionService } from './whatsapp-connection.service';
export {
  EmbeddedSignupError,
  EmbeddedSignupPort,
} from './ports/embedded-signup.port';

@Module({
  imports: [
    CoreModule,
    AuthModule,
    // EntitlementGuard on the routes (blocks lapsed tenants, not trials).
    BillingModule,
    MetaGraphModule,
    TenantContextModule,
    WhatsappModule,
  ],
  controllers: [ConnectController],
  providers: [
    ConnectService,
    ConnectStateService,
    WhatsappConnectionService,
    MetaEmbeddedSignupAdapter,
    { provide: EmbeddedSignupPort, useExisting: MetaEmbeddedSignupAdapter },
  ],
  exports: [ConnectService, ConnectStateService, WhatsappConnectionService],
})
export class ConnectModule implements NestModule {
  configure(consumer: MiddlewareConsumer): void {
    consumer.apply(TenantAuthMiddleware).forRoutes(ConnectController);
  }
}
