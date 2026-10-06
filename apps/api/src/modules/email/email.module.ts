import { Module } from '@nestjs/common';
import { AppConfigService, CoreModule } from '../core';
import { NoopEmailSender } from './noop-email-sender.adapter';
import { EmailSender } from './ports/email-sender.port';
import { ResendEmailSender } from './resend-email-sender.adapter';

export * from './ports/email-sender.port';
export { NoopEmailSender } from './noop-email-sender.adapter';
export { ResendEmailSender } from './resend-email-sender.adapter';

// Platform: outbound mail the product itself originates.
//
// Owns no templates and no recipient policy on purpose — those belong to
// whichever feature is sending, the same way ObjectStorage owns bytes and not
// what they mean. Today the only consumer is NotificationsModule's critical
// alert mail.
@Module({
  imports: [CoreModule],
  providers: [
    NoopEmailSender,
    ResendEmailSender,
    {
      // Both are constructed, one is bound. ResendEmailSender reads its key
      // per-request, so constructing it under EMAIL_PROVIDER=none is harmless.
      provide: EmailSender,
      useFactory: (
        config: AppConfigService,
        resend: ResendEmailSender,
        noop: NoopEmailSender,
      ) => (config.emailProvider === 'resend' ? resend : noop),
      inject: [AppConfigService, ResendEmailSender, NoopEmailSender],
    },
  ],
  exports: [EmailSender],
})
export class EmailModule {}
