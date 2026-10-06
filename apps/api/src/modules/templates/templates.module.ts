import { MiddlewareConsumer, Module, type NestModule } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { TenantAuthMiddleware } from '../auth/tenant-auth.middleware';
import { BillingModule } from '../billing/billing.module';
import { CustomerModule } from '../customer/customer.module';
import { TenantContextModule } from '../tenant-context/tenant-context.module';
import { WhatsappModule } from '../whatsapp/whatsapp.module';
import { MessageTemplateService } from './message-template.service';
import { TemplateSendService } from './template-send.service';
import { TemplateSubmissionService } from './template-submission.service';
import { TemplateSyncService } from './template-sync.service';
import { TemplatesController } from './templates.controller';

export { MessageTemplateService } from './message-template.service';
export type { MessageTemplateRecord } from './message-template.service';
// F26 (D5): the shared half of every approved-template send. Exported here so
// its two callers — InboxModule's human path and CourierModule's automated
// shipment notifications — use one set of approval/category/consent guards
// rather than two copies that drift.
export { TemplateSendService } from './template-send.service';
export type {
  TemplatePrepareInput,
  TemplatePrepareResult,
  TemplateSendConversation,
  TemplateSendPlan,
  TemplateSendRefusal,
  TemplateDispatchResult,
} from './template-send.service';
export * from './template-body';

// Product shell: the message template library (F12) — what a human is allowed
// to send, as opposed to the sending itself, which stays with the rest of
// human replying in InboxModule.
//
// Owns `message_templates`, including reconciling their approval state with
// the BSP — a stored `approved` nobody ever checked against Meta is worse
// than no status at all, so the sync belongs with the thing it corrects.
//
// The BSP dependency is confined to TemplateSyncService and
// TemplateSubmissionService: MessageTemplateService itself never reaches a
// vendor, so the store stays testable without one. Submission is the write
// half of the same seam sync reads — one asks the BSP to review a template,
// the other asks what it decided. Neither may write `approved` on its own.
@Module({
  imports: [
    AuthModule,
    BillingModule,
    // F26 (D5): TemplateSendService checks consent before every send — a
    // template is business-initiated by definition.
    CustomerModule,
    TenantContextModule,
    WhatsappModule,
  ],
  controllers: [TemplatesController],
  providers: [
    MessageTemplateService,
    TemplateSendService,
    TemplateSubmissionService,
    TemplateSyncService,
  ],
  exports: [MessageTemplateService, TemplateSendService],
})
export class TemplatesModule implements NestModule {
  configure(consumer: MiddlewareConsumer): void {
    consumer.apply(TenantAuthMiddleware).forRoutes(TemplatesController);
  }
}
