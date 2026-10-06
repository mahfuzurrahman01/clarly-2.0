import { NotFoundException } from '@nestjs/common';
import type { TenantContextService } from '../tenant-context/tenant-context.service';
import { AnswerFeedbackService } from './answer-feedback.service';

const TENANT_A = 'tenant-a';
const CONVERSATION_ID = 'conv-1';
const MESSAGE_ID = 'message-1';

interface Write {
  kind: 'insert' | 'delete';
  values?: Record<string, unknown>;
}

function makeTenantContext(responses: unknown[]) {
  let call = 0;
  const writes: Write[] = [];
  const withTenantTx = jest.fn((fn: (tx: unknown) => unknown) => {
    const response = responses[call++] ?? [];
    const tx = {
      select: () => ({
        from: () => ({
          where: () => ({ limit: () => Promise.resolve(response) }),
        }),
      }),
      insert: () => ({
        values: (values: Record<string, unknown>) => {
          writes.push({ kind: 'insert', values });
          return { onConflictDoUpdate: () => Promise.resolve(undefined) };
        },
      }),
      delete: () => {
        writes.push({ kind: 'delete' });
        return { where: () => Promise.resolve(undefined) };
      },
    };
    return fn(tx);
  });

  return {
    tenantContext: { withTenantTx } as unknown as TenantContextService,
    writes,
  };
}

const RATE = {
  tenantId: TENANT_A,
  conversationId: CONVERSATION_ID,
  messageId: MESSAGE_ID,
  rating: 'down' as const,
  note: 'Quoted the wrong refund window.',
  userId: 'user-1',
};

describe('AnswerFeedbackService', () => {
  it('records the rating, the note and who gave it', async () => {
    const { tenantContext, writes } = makeTenantContext([[{ id: MESSAGE_ID }]]);
    const service = new AnswerFeedbackService(tenantContext);

    await service.rate(RATE);

    expect(writes[0].values).toMatchObject({
      tenantId: TENANT_A,
      messageId: MESSAGE_ID,
      rating: 'down',
      note: 'Quoted the wrong refund window.',
      ratedBy: 'user-1',
    });
  });

  it("refuses to rate anything but an agent reply — a customer's own words are noise in an eval corpus", async () => {
    // The lookup filters on role='assistant', so a user or human_agent row
    // comes back empty.
    const { tenantContext, writes } = makeTenantContext([[]]);
    const service = new AnswerFeedbackService(tenantContext);

    await expect(service.rate(RATE)).rejects.toBeInstanceOf(NotFoundException);
    expect(writes).toHaveLength(0);
  });

  it('refuses a message that belongs to a different conversation', async () => {
    const { tenantContext } = makeTenantContext([[]]);
    const service = new AnswerFeedbackService(tenantContext);

    await expect(
      service.rate({ ...RATE, conversationId: 'someone-elses-conversation' }),
    ).rejects.toBeInstanceOf(NotFoundException);
  });

  it('clears a rating without writing a thumbs-down in its place', async () => {
    const { tenantContext, writes } = makeTenantContext([[{ id: MESSAGE_ID }]]);
    const service = new AnswerFeedbackService(tenantContext);

    await service.clear({
      tenantId: TENANT_A,
      conversationId: CONVERSATION_ID,
      messageId: MESSAGE_ID,
    });

    expect(writes).toEqual([{ kind: 'delete' }]);
  });
});
