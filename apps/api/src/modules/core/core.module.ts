import { Global, Module } from '@nestjs/common';
import { AppConfigService } from './config/app-config.service';
import { AppLoggerService } from './logger/app-logger.service';
import { Clock } from './clock/clock';
import { SystemClock } from './clock/system-clock';
import { Sleep } from './sleep/sleep';
import { RealSleep } from './sleep/real-sleep';

// Platform: config/logger/clock/sleep. No dependency-rule constraints apply.
//
// @Global() — every other module needs AppConfigService/AppLoggerService/Clock
// constantly (T5's connection strings, T4/T10's timers, every module's
// logging) and none of it is tenant- or request-scoped, so importing
// CoreModule once in AppModule and injecting these three everywhere avoids
// re-importing CoreModule in all 20+ feature modules for no benefit. Sleep
// (Feature 3, A4) is the same pattern — A4's retry backoff needs a testable
// "wait" abstraction, not real timers in unit tests.
@Global()
@Module({
  imports: [],
  controllers: [],
  providers: [
    AppConfigService,
    AppLoggerService,
    { provide: Clock, useClass: SystemClock },
    { provide: Sleep, useClass: RealSleep },
  ],
  exports: [AppConfigService, AppLoggerService, Clock, Sleep],
})
export class CoreModule {}
