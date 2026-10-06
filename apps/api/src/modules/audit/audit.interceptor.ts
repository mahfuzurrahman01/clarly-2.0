// Platform (AuditModule): the reason the audit log can claim to be complete.
//
// Registered globally (APP_INTERCEPTOR in audit.module.ts), so a new admin
// endpoint is audited the day it is written, by someone who has never heard of
// this file. That is the whole design: completeness is structural, not a thing
// anyone has to remember. Handlers may enrich an entry (see audit-detail.ts),
// and none are required to.
//
// What gets recorded, and why the filter is where it is:
//
//   request
//      │
//      ├── no `req.auth`?           ─► skip. Unauthenticated or pre-tenant
//      │                               (signup, webhooks, health). No actor to
//      │                               attribute, and the BSP webhook path is
//      │                               high-volume machine traffic.
//      │
//      ├── GET / HEAD / OPTIONS?    ─► skip. Reading is not an auditable
//      │                               action here, and logging it would bury
//      │                               real changes under console polling.
//      │
//      └── otherwise                ─► one row, AFTER the handler settles.
//                    │
//                    ├── resolved ─► outcome `success`, the response status
//                    └── threw    ─► outcome `failure`, the exception status,
//                                    and the error is rethrown untouched
//
// Recording after the handler settles is what makes this an outcome log rather
// than an intent log. A rejected attempt — a non-admin probing an admin route,
// a delete that 404s — is recorded as a failure, which for a security review is
// often the more interesting row.
import {
  Injectable,
  type CallHandler,
  type ExecutionContext,
  type NestInterceptor,
  HttpException,
} from '@nestjs/common';
import type { Request, Response } from 'express';
import { type Observable, tap } from 'rxjs';
import type { AuditOutcome } from '../persistence/drizzle/schema';
import type { AuditDraft } from './audit-detail';
import { AuditLogService } from './audit-log.service';

const READ_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

@Injectable()
export class AuditInterceptor implements NestInterceptor {
  constructor(private readonly auditLog: AuditLogService) {}

  intercept(context: ExecutionContext, next: CallHandler): Observable<unknown> {
    // Non-HTTP contexts (the SSE stream still counts as HTTP; queue workers do
    // not) have no request to audit.
    if (context.getType() !== 'http') return next.handle();

    const request = context.switchToHttp().getRequest<Request>();
    const auth = request.auth;

    if (!auth || READ_METHODS.has(request.method.toUpperCase())) {
      return next.handle();
    }

    // Attached before the handler runs so `@Audit()` has somewhere to write.
    const draft: AuditDraft = { detail: null };
    request.auditDraft = draft;

    const response = context.switchToHttp().getResponse<Response>();
    const route = routePattern(request);
    const targetId = primaryParam(request);

    const write = (statusCode: number, outcome: AuditOutcome): void => {
      // Fire-and-forget: AuditLogService.record() never throws, and awaiting it
      // would hold the response open on a write the caller cannot act on.
      void this.auditLog.record({
        tenantId: auth.tenantId,
        actorUserId: auth.userId,
        actorRole: auth.appRole ?? null,
        method: request.method.toUpperCase(),
        route,
        targetId,
        statusCode,
        outcome,
        detail: draft.detail,
        detailKey: draft.detailKey ?? null,
        detailParams: draft.detailParams ?? null,
      });
    };

    return next.handle().pipe(
      tap({
        next: () => write(response.statusCode, draft.outcome ?? 'success'),
        error: (error: unknown) => {
          write(statusOf(error), 'failure');
        },
      }),
    );
  }
}

/**
 * The route pattern (`/knowledge-base/documents/:id`), not the resolved path.
 *
 * Storing the pattern is what makes "show me every document deletion" a
 * grouping instead of a regex over uuids. Express exposes it on `route.path`,
 * which is missing when nothing matched (a 404) — then the raw path is the
 * only truthful answer, and a 404 on an unknown path is itself worth seeing.
 */
function routePattern(request: Request): string {
  const matched = (request.route as { path?: string } | undefined)?.path;
  if (typeof matched === 'string' && matched.length > 0) {
    return `${request.baseUrl ?? ''}${matched}`;
  }
  // Query string stripped: it can carry values that do not belong in a log.
  return request.path;
}

/**
 * The thing acted upon: `:id` when present, else the single param when there
 * is exactly one. With several params there is no defensible "primary" one, so
 * this records none rather than guessing wrong — the route pattern still says
 * what kind of action it was.
 */
function primaryParam(request: Request): string | null {
  const params = request.params ?? {};
  if (typeof params.id === 'string') return params.id;

  const values = Object.values(params).filter(
    (value): value is string => typeof value === 'string',
  );
  return values.length === 1 ? values[0] : null;
}

/** Nest exceptions carry their own status; anything else reaching here became a 500. */
function statusOf(error: unknown): number {
  return error instanceof HttpException ? error.getStatus() : 500;
}
