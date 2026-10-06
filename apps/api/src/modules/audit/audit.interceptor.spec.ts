import { ForbiddenException, NotFoundException } from '@nestjs/common';
import type { CallHandler, ExecutionContext } from '@nestjs/common';
import { of, throwError, lastValueFrom, firstValueFrom } from 'rxjs';
import type { AuditLogService } from './audit-log.service';
import { AuditInterceptor } from './audit.interceptor';

const TENANT = 'tenant-a';

function makeContext(overrides: {
  method?: string;
  auth?: unknown;
  routePath?: string;
  baseUrl?: string;
  path?: string;
  params?: Record<string, string>;
  statusCode?: number;
  type?: string;
}) {
  const request: Record<string, unknown> = {
    method: overrides.method ?? 'DELETE',
    auth:
      'auth' in overrides
        ? overrides.auth
        : {
            userId: 'user-1',
            tenantId: TENANT,
            role: 'authenticated',
            appRole: 'admin',
          },
    route: overrides.routePath ? { path: overrides.routePath } : undefined,
    baseUrl: overrides.baseUrl ?? '',
    path: overrides.path ?? '/knowledge-base/documents/doc-1',
    params: overrides.params ?? { id: 'doc-1' },
  };
  const response = { statusCode: overrides.statusCode ?? 200 };

  const context = {
    getType: () => overrides.type ?? 'http',
    switchToHttp: () => ({
      getRequest: () => request,
      getResponse: () => response,
    }),
  } as unknown as ExecutionContext;

  return { context, request };
}

function makeHarness() {
  const record = jest.fn().mockResolvedValue(undefined);
  const auditLog = { record } as unknown as AuditLogService;
  return { interceptor: new AuditInterceptor(auditLog), record };
}

const okHandler: CallHandler = { handle: () => of({ deleted: true }) };

describe('AuditInterceptor', () => {
  it('records a state-changing request with actor, route pattern and target', async () => {
    const { interceptor, record } = makeHarness();
    const { context } = makeContext({
      routePath: '/knowledge-base/documents/:id',
      statusCode: 200,
    });

    await lastValueFrom(interceptor.intercept(context, okHandler));

    expect(record).toHaveBeenCalledWith({
      tenantId: TENANT,
      actorUserId: 'user-1',
      actorRole: 'admin',
      method: 'DELETE',
      route: '/knowledge-base/documents/:id',
      targetId: 'doc-1',
      statusCode: 200,
      outcome: 'success',
      detail: null,
      detailKey: null,
      detailParams: null,
    });
  });

  // The pattern, not the resolved path — otherwise "every document deletion"
  // is a regex over uuids instead of a grouping.
  it('stores the route pattern rather than the resolved path', async () => {
    const { interceptor, record } = makeHarness();
    const { context } = makeContext({
      routePath: '/documents/:id',
      baseUrl: '/knowledge-base',
      path: '/knowledge-base/documents/doc-1',
    });

    await lastValueFrom(interceptor.intercept(context, okHandler));

    expect(record).toHaveBeenCalledWith(
      expect.objectContaining({ route: '/knowledge-base/documents/:id' }),
    );
  });

  // Recording after the handler settles is what makes this an outcome log
  // rather than an intent log. A rejected attempt is the interesting row.
  it('records a rejected action as a failure with the exception status', async () => {
    const { interceptor, record } = makeHarness();
    const { context } = makeContext({ routePath: '/documents/:id' });
    const failing: CallHandler = {
      handle: () => throwError(() => new ForbiddenException()),
    };

    await expect(
      firstValueFrom(interceptor.intercept(context, failing)),
    ).rejects.toBeInstanceOf(ForbiddenException);

    expect(record).toHaveBeenCalledWith(
      expect.objectContaining({ outcome: 'failure', statusCode: 403 }),
    );
  });

  it('rethrows the original error untouched', async () => {
    const { interceptor } = makeHarness();
    const { context } = makeContext({ routePath: '/documents/:id' });
    const notFound = new NotFoundException('Document not found');
    const failing: CallHandler = { handle: () => throwError(() => notFound) };

    await expect(
      firstValueFrom(interceptor.intercept(context, failing)),
    ).rejects.toBe(notFound);
  });

  it('records a non-HTTP exception as a 500 failure', async () => {
    const { interceptor, record } = makeHarness();
    const { context } = makeContext({ routePath: '/documents/:id' });
    const failing: CallHandler = {
      handle: () => throwError(() => new Error('pool exhausted')),
    };

    await expect(
      firstValueFrom(interceptor.intercept(context, failing)),
    ).rejects.toThrow('pool exhausted');

    expect(record).toHaveBeenCalledWith(
      expect.objectContaining({ outcome: 'failure', statusCode: 500 }),
    );
  });

  // Reads are not auditable actions here, and logging them would bury real
  // changes under the console's polling.
  it.each(['GET', 'HEAD', 'OPTIONS'])('does not record %s', async (method) => {
    const { interceptor, record } = makeHarness();
    const { context } = makeContext({ method, routePath: '/documents' });

    await lastValueFrom(interceptor.intercept(context, okHandler));

    expect(record).not.toHaveBeenCalled();
  });

  // No actor to attribute: signup, BSP webhooks, health. The webhook path is
  // also high-volume machine traffic that would swamp the log.
  it('does not record a request with no auth context', async () => {
    const { interceptor, record } = makeHarness();
    const { context } = makeContext({
      auth: undefined,
      routePath: '/webhooks',
    });

    await lastValueFrom(interceptor.intercept(context, okHandler));

    expect(record).not.toHaveBeenCalled();
  });

  it('ignores non-HTTP execution contexts', async () => {
    const { interceptor, record } = makeHarness();
    const { context } = makeContext({ type: 'rpc' });

    await lastValueFrom(interceptor.intercept(context, okHandler));

    expect(record).not.toHaveBeenCalled();
  });

  it('carries a handler-supplied description onto the entry', async () => {
    const { interceptor, record } = makeHarness();
    const { context, request } = makeContext({ routePath: '/documents/:id' });

    const describing: CallHandler = {
      handle: () => {
        (request.auditDraft as { detail: string | null }).detail =
          'Deleted knowledge-base document "refund-policy.pdf"';
        return of({ ok: true });
      },
    };

    await lastValueFrom(interceptor.intercept(context, describing));

    expect(record).toHaveBeenCalledWith(
      expect.objectContaining({
        detail: 'Deleted knowledge-base document "refund-policy.pdf"',
      }),
    );
  });

  it('carries the description key and params onto the entry, null when the handler gave none', async () => {
    const { interceptor, record } = makeHarness();
    const keyed = makeContext({ routePath: '/orders/:id/approve' });

    const describingWithKey: CallHandler = {
      handle: () => {
        Object.assign(keyed.request.auditDraft as object, {
          detail: 'Cancelled order ORD-1',
          detailKey: 'order.cancelled',
          detailParams: { orderRef: 'ORD-1' },
        });
        return of({ ok: true });
      },
    };
    await lastValueFrom(
      interceptor.intercept(keyed.context, describingWithKey),
    );

    expect(record).toHaveBeenLastCalledWith(
      expect.objectContaining({
        detail: 'Cancelled order ORD-1',
        detailKey: 'order.cancelled',
        detailParams: { orderRef: 'ORD-1' },
      }),
    );

    const plain = makeContext({ routePath: '/documents/:id' });
    await lastValueFrom(interceptor.intercept(plain.context, okHandler));

    expect(record).toHaveBeenLastCalledWith(
      expect.objectContaining({
        detail: null,
        detailKey: null,
        detailParams: null,
      }),
    );
  });

  // A described action that then fails must be recorded as a failure that
  // still carries its description — not as a success that never happened.
  it('keeps the description when the handler describes then throws', async () => {
    const { interceptor, record } = makeHarness();
    const { context, request } = makeContext({ routePath: '/documents/:id' });

    const describingThenFailing: CallHandler = {
      handle: () => {
        (request.auditDraft as { detail: string | null }).detail =
          'Deleting document';
        return throwError(() => new NotFoundException());
      },
    };

    await expect(
      firstValueFrom(interceptor.intercept(context, describingThenFailing)),
    ).rejects.toBeInstanceOf(NotFoundException);

    expect(record).toHaveBeenCalledWith(
      expect.objectContaining({
        detail: 'Deleting document',
        outcome: 'failure',
      }),
    );
  });

  // ISSUE-002: a handler can resolve normally (201) while the thing it did
  // failed — a template the BSP rejected. The entry must say failure.
  it('records a failure outcome when the handler flags one on a resolved request', async () => {
    const { interceptor, record } = makeHarness();
    const { context, request } = makeContext({
      method: 'POST',
      routePath: '/conversations/:id/template-messages',
    });

    const resolvedButFailed: CallHandler = {
      handle: () => {
        const draft = request.auditDraft as {
          detail: string | null;
          outcome?: string;
        };
        draft.detail = 'Template send failed: boom';
        draft.outcome = 'failure';
        return of({ delivered: false });
      },
    };

    await lastValueFrom(interceptor.intercept(context, resolvedButFailed));

    expect(record).toHaveBeenCalledWith(
      expect.objectContaining({
        outcome: 'failure',
        detail: 'Template send failed: boom',
      }),
    );
  });

  it('records a null role when the actor has no app_role claim yet', async () => {
    const { interceptor, record } = makeHarness();
    const { context } = makeContext({
      auth: { userId: 'user-1', tenantId: TENANT, role: 'authenticated' },
      routePath: '/documents/:id',
    });

    await lastValueFrom(interceptor.intercept(context, okHandler));

    expect(record).toHaveBeenCalledWith(
      expect.objectContaining({ actorRole: null }),
    );
  });

  describe('target id', () => {
    it('uses the single param when the route has exactly one', async () => {
      const { interceptor, record } = makeHarness();
      const { context } = makeContext({
        params: { userId: 'user-9' },
        routePath: '/onboarding/team/:userId',
      });

      await lastValueFrom(interceptor.intercept(context, okHandler));

      expect(record).toHaveBeenCalledWith(
        expect.objectContaining({ targetId: 'user-9' }),
      );
    });

    // With several params there is no defensible primary — recording none
    // beats recording the wrong one; the route pattern still says what kind
    // of action it was.
    it('records none when several params make "primary" ambiguous', async () => {
      const { interceptor, record } = makeHarness();
      const { context } = makeContext({
        params: { conversationId: 'c-1', messageId: 'm-1' },
        routePath:
          '/conversations/:conversationId/messages/:messageId/feedback',
      });

      await lastValueFrom(interceptor.intercept(context, okHandler));

      expect(record).toHaveBeenCalledWith(
        expect.objectContaining({ targetId: null }),
      );
    });

    it('prefers :id when it is present alongside others', async () => {
      const { interceptor, record } = makeHarness();
      const { context } = makeContext({
        params: { id: 'doc-1', other: 'x' },
        routePath: '/documents/:id',
      });

      await lastValueFrom(interceptor.intercept(context, okHandler));

      expect(record).toHaveBeenCalledWith(
        expect.objectContaining({ targetId: 'doc-1' }),
      );
    });
  });

  // An unmatched route still deserves an entry — a 404 on an unknown admin
  // path is itself worth seeing. The query string is dropped: it can carry
  // values that do not belong in a log.
  it('falls back to the raw path when no route matched', async () => {
    const { interceptor, record } = makeHarness();
    const { context } = makeContext({
      routePath: undefined,
      path: '/knowledge-base/documents/unknown',
      params: {},
    });

    await lastValueFrom(interceptor.intercept(context, okHandler));

    expect(record).toHaveBeenCalledWith(
      expect.objectContaining({
        route: '/knowledge-base/documents/unknown',
        targetId: null,
      }),
    );
  });
});
