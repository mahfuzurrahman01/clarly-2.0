import { Module } from '@nestjs/common';
import { APP_FILTER } from '@nestjs/core';
import { SentryModule } from '@sentry/nestjs/setup';
import { SentryGlobalFilter } from '@sentry/nestjs/setup';
import { PersistenceModule } from '../persistence/persistence.module';
import { QueueModule } from '../queue/queue.module';
import { AlertingModule } from '../alerting/alerting.module';
import { EmailModule } from '../email/email.module';
import { HealthController } from './health.controller';
import { PlatformHealthPagingSubscriber } from './platform-health-paging.subscriber';

// Platform: OTel, latency histograms, security events (T9) — deferred.
//
// T18: a public, unauthenticated GET /health endpoint for external
// synthetic uptime monitors. Reuses PersistenceService.ping() and
// QueueHealthService.ping() (both previously unused outside their own
// modules) rather than a third connectivity-check mechanism.
//
// Launch Plan item 7: SentryModule.forRoot() wires @sentry/nestjs's
// automatic instrumentation (HTTP, Nest's request pipeline); it is a real
// no-op when SENTRY_DSN is unset (instrument.ts skips Sentry.init()
// entirely — see that file). SentryGlobalFilter reports every unhandled
// error to Sentry AND still returns Nest's normal error response — this app
// has no other catch-all filter (grep confirms), so this is the only
// exception filter registered, per @sentry/nestjs's own setup docs ("if you
// do not have a global catch-all exception filter, add SentryGlobalFilter").
// PlatformHealthPagingSubscriber is this module's home for the same reason
// AlertNotificationSubscriber lives in NotificationsModule: it is a pure
// event listener wiring one alert source to its delivery channel(s), no
// business logic of its own.
@Module({
  imports: [
    PersistenceModule,
    QueueModule,
    AlertingModule,
    EmailModule,
    SentryModule.forRoot(),
  ],
  controllers: [HealthController],
  providers: [
    PlatformHealthPagingSubscriber,
    { provide: APP_FILTER, useClass: SentryGlobalFilter },
  ],
  exports: [],
})
export class ObservabilityModule {}
