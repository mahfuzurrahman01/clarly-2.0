// Platform (CoreModule): structured logger. Implements Nest's LoggerService
// so it can be swapped in globally via `app.useLogger(...)` in main.ts and
// injected anywhere via DI. Emits single-line JSON to stdout/stderr —
// container-friendly, greppable, and ready for a log-shipper (Sentry/OTel
// wiring lands in ObservabilityModule per T9/Feature 7, not here).
import {
  Injectable,
  type LoggerService,
  type LogLevel,
  Scope,
} from '@nestjs/common';
import { AppConfigService } from '../config/app-config.service';

interface LogEntry {
  timestamp: string;
  level: LogLevel;
  message: string;
  context?: string;
  [key: string]: unknown;
}

const LEVEL_ORDER: Record<LogLevel, number> = {
  verbose: 0,
  debug: 1,
  log: 2,
  warn: 3,
  error: 4,
  fatal: 5,
};

/**
 * Request/transaction-scoped so a future `.withContext({ tenantId })` binding
 * (once TenantContextModule exists at call sites) can attach structured
 * fields without changing every call site's signature. Scope.TRANSIENT is
 * deliberately NOT used here — DEFAULT (singleton) keeps this cheap; per-call
 * `context` is passed as Nest's standard second constructor arg / method arg.
 */
@Injectable({ scope: Scope.DEFAULT })
export class AppLoggerService implements LoggerService {
  private readonly minLevel: LogLevel;

  constructor(config: AppConfigService) {
    this.minLevel = config.nodeEnv === 'production' ? 'log' : 'verbose';
  }

  log(message: unknown, context?: string): void {
    this.write('log', message, context);
  }

  error(message: unknown, trace?: string, context?: string): void {
    this.write('error', message, context, trace ? { trace } : undefined);
  }

  warn(message: unknown, context?: string): void {
    this.write('warn', message, context);
  }

  debug(message: unknown, context?: string): void {
    this.write('debug', message, context);
  }

  verbose(message: unknown, context?: string): void {
    this.write('verbose', message, context);
  }

  private write(
    level: LogLevel,
    message: unknown,
    context?: string,
    meta?: Record<string, unknown>,
  ): void {
    if (LEVEL_ORDER[level] < LEVEL_ORDER[this.minLevel]) return;

    const entry: LogEntry = {
      timestamp: new Date().toISOString(),
      level,
      message: message instanceof Error ? message.message : String(message),
      ...(context ? { context } : {}),
      ...(meta ?? {}),
    };

    const stream =
      level === 'error' || level === 'fatal' ? console.error : console.log;
    stream(JSON.stringify(entry));
  }
}
