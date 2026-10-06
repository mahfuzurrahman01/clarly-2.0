// Clarly 2.0 S2 (docs/v2/ARCHITECTURE.md §3.3): appointments, from Autologic's
// agency mode, rebuilt on Clarly's engine — RLS tables, agent tools with zod
// schemas, a calendar port, and per-tenant time zones.
import {
  type MiddlewareConsumer,
  Module,
  type NestModule,
} from '@nestjs/common';
import { AuditModule } from '../audit/audit.module';
import { AuthModule } from '../auth/auth.module';
import { TenantAuthMiddleware } from '../auth/tenant-auth.middleware';
import { BillingModule } from '../billing/billing.module';
import { CoreModule } from '../core';
import { NotificationRecordModule } from '../notifications/notification-record.module';
import { PersistenceModule } from '../persistence/persistence.module';
import { QueueModule } from '../queue/queue.module';
import { TenantContextModule } from '../tenant-context/tenant-context.module';
import { ToolRegistryModule } from '../tool-registry/tool-registry.module';
import { WhatsappModule } from '../whatsapp/whatsapp.module';
import { BookingCatalogService } from './booking-catalog.service';
import {
  BookingCalendarCallbackController,
  BookingCalendarController,
} from './booking-calendar.controller';
import { BookingServicesController } from './booking-services.controller';
import { BookingSettingsController } from './booking-settings.controller';
import { BookingSettingsService } from './booking-settings.service';
import {
  BookAppointmentExecutor,
  CheckAvailabilityExecutor,
} from './booking-tool-executors';
import { BookingToolSeederService } from './booking-tool-seeder.service';
import { BookingService } from './booking.service';
import { BookingsController } from './bookings.controller';
import { CalendarConnectionService } from './calendar/calendar-connection.service';
import { CalendarOAuthStateService } from './calendar/calendar-oauth-state.service';
import { CalendarProvider } from './calendar/calendar-provider.port';
import { GoogleCalendarProvider } from './calendar/google-calendar.provider';

export * from './booking.dto';
export * from './booking-tools';
export { BookingService } from './booking.service';
export { BookingSettingsService } from './booking-settings.service';
export { BookingToolSeederService } from './booking-tool-seeder.service';
export {
  BookAppointmentExecutor,
  CheckAvailabilityExecutor,
} from './booking-tool-executors';

@Module({
  imports: [
    CoreModule,
    PersistenceModule,
    TenantContextModule,
    AuthModule,
    AuditModule,
    BillingModule,
    NotificationRecordModule,
    ToolRegistryModule,
    QueueModule,
    WhatsappModule,
  ],
  // Order matters: Nest registers routes in this order, and the literal
  // `bookings/settings|services|calendar` paths must win over `bookings/:id`.
  controllers: [
    BookingSettingsController,
    BookingServicesController,
    BookingCalendarCallbackController,
    BookingCalendarController,
    BookingsController,
  ],
  providers: [
    BookingSettingsService,
    BookingCatalogService,
    BookingService,
    BookingToolSeederService,
    CheckAvailabilityExecutor,
    BookAppointmentExecutor,
    CalendarConnectionService,
    CalendarOAuthStateService,
    GoogleCalendarProvider,
    { provide: CalendarProvider, useExisting: GoogleCalendarProvider },
  ],
  exports: [
    BookingService,
    BookingSettingsService,
    BookingToolSeederService,
    CheckAvailabilityExecutor,
    BookAppointmentExecutor,
  ],
})
export class BookingModule implements NestModule {
  configure(consumer: MiddlewareConsumer): void {
    consumer
      .apply(TenantAuthMiddleware)
      .forRoutes(
        BookingSettingsController,
        BookingServicesController,
        BookingCalendarController,
        BookingsController,
      );
  }
}
