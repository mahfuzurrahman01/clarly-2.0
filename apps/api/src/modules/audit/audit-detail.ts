// The enrichment half of the audit log (see audit.interceptor.ts for the
// other half).
//
// The interceptor records every admin action on its own — actor, route,
// target, outcome — so the log is complete whether or not anyone here does
// anything. What the interceptor cannot know is what actually changed:
// `DELETE /knowledge-base/documents/:id` and "removed the refund policy PDF"
// are the same request, and only the handler knows the second one.
//
// So a handler MAY describe its own action, and nothing breaks when it does
// not:
//
//   async remove(@CurrentAuth() auth, @Param('id') id, @Audit() audit) {
//     const doc = await this.docs.delete(auth.tenantId, id);
//     audit.describe('kb_document.deleted', {
//       filename: doc.filename,
//       chunkCount: doc.chunkCount,
//     });
//   }
//
// A handler names WHAT happened by key and passes the values; the English
// sentence comes from audit-detail-catalog.ts. That is what lets the console
// show the entry in the operator's language (QA 2026-10-05).
//
// The description is attached to the request, not written directly, because
// the handler does not yet know its own outcome — it may still throw on the
// way out. The interceptor writes one row after the handler resolves or
// rejects, so a described-then-failed action is recorded as a failure with
// its description intact, rather than as a success that never happened.
import { createParamDecorator, type ExecutionContext } from '@nestjs/common';
import type { Request } from 'express';
import type { AuditOutcome } from '../persistence/drizzle/schema';
import {
  renderAuditDetail,
  type AuditDetailKey,
  type AuditDetailParams,
} from './audit-detail-catalog';

/** Handed to a handler by `@Audit()`. Deliberately write-only: a handler describes its action, it does not read or edit the audit trail. */
export interface AuditDetail {
  /** Describe what this action changed, by catalogue key and the values involved. Last call wins. */
  describe<K extends AuditDetailKey>(
    key: K,
    params: AuditDetailParams<K>,
  ): void;
}

/** `AuditDetail` plus `fail()`, for the rare handler whose normal response can still mean the action failed. Separate so handlers that only describe are not forced to supply it. */
export interface AuditDetailWithOutcome extends AuditDetail {
  /**
   * For an action that resolved normally but did not achieve its purpose (a
   * send the BSP rejected, answered 201 by design). Records the entry as a
   * failure with this description, so the log does not read as success.
   */
  fail<K extends AuditDetailKey>(key: K, params: AuditDetailParams<K>): void;
}

/** Where the description waits between the handler setting it and the interceptor writing the row. */
export interface AuditDraft {
  /** English, rendered from `detailKey` + `detailParams`. */
  detail: string | null;
  detailKey?: AuditDetailKey | null;
  detailParams?: Readonly<Record<string, string | number>> | null;
  /** Set only by `fail()`; overrides the `success` the interceptor would otherwise record for a resolved handler. */
  outcome?: AuditOutcome;
}

declare module 'express' {
  interface Request {
    /** Created by AuditInterceptor for auditable requests. Absent on reads and on unauthenticated routes. */
    auditDraft?: AuditDraft;
  }
}

export function auditDetailFactory(
  _data: unknown,
  ctx: ExecutionContext,
): AuditDetailWithOutcome {
  const request = ctx.switchToHttp().getRequest<Request>();
  const write = <K extends AuditDetailKey>(
    key: K,
    params: AuditDetailParams<K>,
  ): boolean => {
    // No draft means this request is not being audited — a read, or a route
    // the interceptor does not cover. Silently ignored rather than thrown:
    // a handler should never fail because of its own audit annotation, and
    // the completeness guarantee does not depend on this path running.
    if (!request.auditDraft) return false;
    request.auditDraft.detail = renderAuditDetail(key, params);
    request.auditDraft.detailKey = key;
    request.auditDraft.detailParams = { ...params };
    return true;
  };
  return {
    describe(key, params): void {
      write(key, params);
    },
    fail(key, params): void {
      if (write(key, params) && request.auditDraft) {
        request.auditDraft.outcome = 'failure';
      }
    },
  };
}

export const Audit = createParamDecorator(auditDetailFactory);
