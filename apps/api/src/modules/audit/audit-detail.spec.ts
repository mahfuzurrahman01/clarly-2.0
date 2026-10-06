import type { ExecutionContext } from '@nestjs/common';
import { auditDetailFactory } from './audit-detail';

function makeContext(request: Record<string, unknown>): ExecutionContext {
  return {
    switchToHttp: () => ({ getRequest: () => request }),
  } as unknown as ExecutionContext;
}

describe('auditDetailFactory()', () => {
  it('writes the English description, its key and its params onto the request draft', () => {
    const request: Record<string, unknown> = {
      auditDraft: { detail: null },
    };

    auditDetailFactory(undefined, makeContext(request)).describe(
      'kb_document.deleted',
      { filename: 'refund-policy.pdf', chunkCount: 3 },
    );

    expect(request.auditDraft).toEqual({
      detail:
        'Deleted knowledge-base document "refund-policy.pdf" (3 retrieval chunk(s) removed)',
      detailKey: 'kb_document.deleted',
      detailParams: { filename: 'refund-policy.pdf', chunkCount: 3 },
    });
  });

  it('keeps the last description when called more than once', () => {
    const request: Record<string, unknown> = { auditDraft: { detail: null } };
    const audit = auditDetailFactory(undefined, makeContext(request));

    audit.describe('segment.created', { segmentName: 'first' });
    audit.describe('segment.deleted', { segmentId: 'seg-2' });

    expect(request.auditDraft).toEqual({
      detail: 'Deleted segment seg-2',
      detailKey: 'segment.deleted',
      detailParams: { segmentId: 'seg-2' },
    });
  });

  it('fail() records the keyed description and flips the outcome to failure', () => {
    const request: Record<string, unknown> = { auditDraft: { detail: null } };

    auditDetailFactory(undefined, makeContext(request)).fail(
      'template_message.not_delivered',
      { error: 'send failed' },
    );

    expect(request.auditDraft).toEqual({
      detail: 'Template message was not delivered: send failed',
      detailKey: 'template_message.not_delivered',
      detailParams: { error: 'send failed' },
      outcome: 'failure',
    });
  });

  // A handler must never fail because of its own audit annotation, and the
  // completeness guarantee does not depend on this path running — the
  // interceptor records the entry either way.
  it('does nothing when the request is not being audited', () => {
    const request: Record<string, unknown> = {};

    expect(() =>
      auditDetailFactory(undefined, makeContext(request)).describe(
        'workspace.reopened',
        {},
      ),
    ).not.toThrow();
    expect(request.auditDraft).toBeUndefined();
  });
});
