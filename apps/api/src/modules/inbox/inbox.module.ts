import { MiddlewareConsumer, Module, type NestModule } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { TenantAuthMiddleware } from '../auth/tenant-auth.middleware';
import { BillingModule } from '../billing/billing.module';
import { CustomerModule } from '../customer/customer.module';
import { ConversationModule } from '../conversation/conversation.module';
import { TenantContextModule } from '../tenant-context/tenant-context.module';
import { StorageModule } from '../storage/storage.module';
import { TemplatesModule } from '../templates/templates.module';
import { ChannelModule } from '../channel/channel.module';
import { WhatsappModule } from '../whatsapp/whatsapp.module';
import { AnswerFeedbackService } from './answer-feedback.service';
import { HumanReplyService } from './human-reply.service';
import { TemplateReplyService } from './template-reply.service';
import { InboxController } from './inbox.controller';

// Product shell: the conversation inbox console API.
//
// Same shape as KanbanModule — an HTTP surface that owns no data of its
// own and reads through the module that does (`ConversationModule` owns
// conversations/messages, exactly as `TicketModule` owns tickets).
// `TenantAuthMiddleware` is applied to every route so each handler runs
// with `req.auth` and tenant context resolved.
@Module({
  // WhatsappModule supplies the BspAdapter a human reply is sent through,
  // plus the number directory it is sent from.
  // TemplatesModule supplies the library a template send picks from; this
  // module owns the sending, that one owns what may be sent.
  imports: [
    AuthModule,
    // Launch billing backend (Lane A): supplies EntitlementGuard, applied
    // to the write routes below (send/template-reply, feedback, handover)
    // — reads (list/get conversation, messages, media) stay ungated, same
    // T14 posture as the rest of this controller's role-openness.
    BillingModule,
    ConversationModule,
    // F-consent: a template is business-initiated, so it must not reach a
    // customer who opted out.
    CustomerModule,
    TenantContextModule,
    StorageModule,
    TemplatesModule,
    // Feature 16: HumanReplyService resolves the send adapter and the
    // messaging-window policy by channel. WhatsappModule stays for
    // TemplateReplyService, which is WhatsApp-only by definition (F12).
    ChannelModule,
    WhatsappModule,
  ],
  controllers: [InboxController],
  providers: [HumanReplyService, TemplateReplyService, AnswerFeedbackService],
  // F25: OrderModule imports this module for HumanReplyService — an order
  // approval goes out over the same send path a human agent's reply does.
  // That import landed without the corresponding export; the app could not
  // boot far enough to find out, because the module graph itself was cyclic.
  exports: [HumanReplyService],
})
export class InboxModule implements NestModule {
  configure(consumer: MiddlewareConsumer): void {
    consumer.apply(TenantAuthMiddleware).forRoutes(InboxController);
  }
}
