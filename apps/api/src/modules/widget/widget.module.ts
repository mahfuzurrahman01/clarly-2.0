// Clarly 2.0 S3 (docs/v2/ARCHITECTURE.md §3.1): the website chat widget,
// ported from Autologic and rebuilt as the `web` channel of Clarly's engine.
import {
  type MiddlewareConsumer,
  Module,
  type NestModule,
} from '@nestjs/common';
import { AuditModule } from '../audit/audit.module';
import { AuthModule } from '../auth/auth.module';
import { TenantAuthMiddleware } from '../auth/tenant-auth.middleware';
import { CoreModule } from '../core';
import { PersistenceModule } from '../persistence/persistence.module';
import { QueueModule } from '../queue/queue.module';
import { TenantContextModule } from '../tenant-context/tenant-context.module';
import { WebhookModule } from '../webhook/webhook.module';
import { WidgetConfigService } from './widget-config.service';
import { WidgetConversationService } from './widget-conversation.service';
import { WidgetPublicController } from './widget-public.controller';
import { WidgetRateLimiterService } from './widget-rate-limiter.service';
import { WidgetController } from './widget.controller';

export * from './widget.dto';
export { WidgetConfigService } from './widget-config.service';

@Module({
  imports: [
    CoreModule,
    PersistenceModule,
    TenantContextModule,
    AuthModule,
    AuditModule,
    QueueModule,
    WebhookModule,
  ],
  controllers: [WidgetController, WidgetPublicController],
  providers: [
    WidgetConfigService,
    WidgetConversationService,
    WidgetRateLimiterService,
  ],
  exports: [WidgetConfigService],
})
export class WidgetModule implements NestModule {
  configure(consumer: MiddlewareConsumer): void {
    // The public controller is deliberately NOT here: visitors have no JWT.
    consumer.apply(TenantAuthMiddleware).forRoutes(WidgetController);
  }
}
