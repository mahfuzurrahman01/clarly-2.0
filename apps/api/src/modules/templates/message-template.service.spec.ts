import { ConflictException, NotFoundException } from '@nestjs/common';
import type { TenantContextService } from '../tenant-context/tenant-context.service';
import { MessageTemplateService } from './message-template.service';
import { TemplateBodyError } from './template-body';

const TENANT = 'tenant-a';
const TEMPLATE_ID = 'template-1';

function makeRow(overrides: Record<string, unknown> = {}) {
  return {
    id: TEMPLATE_ID,
    tenantId: TENANT,
    kind: 'whatsapp_template',
    name: 'order_shipped',
    language: 'en',
    category: 'UTILITY',
    body: 'Hi {{1}}, your order {{2}} shipped.',
    variables: [
      { position: 1, label: 'Name', example: 'Rina' },
      { position: 2, label: 'Order', example: 'A-4471' },
    ],
    approvalStatus: 'approved',
    approvalDetail: null,
    syncedAt: new Date('2026-08-19T00:00:00Z'),
    createdAt: new Date('2026-08-18T00:00:00Z'),
    updatedAt: new Date('2026-08-18T00:00:00Z'),
    ...overrides,
  };
}

/**
 * Calls through to the real withTenantTx() callback against a fake tx that
 * matches this service's exact chains — same rationale as the conversation
 * specs: a mock that never invokes the callback leaves the query logic
 * untested, and the branches here (approval reset, variable alignment) all
 * live in what gets passed to `.set()`/`.values()`.
 */
function makeTenantContext(responses: unknown[]) {
  let call = 0;
  const inserted: Record<string, unknown>[] = [];
  const updated: Record<string, unknown>[] = [];
  const withTenantTx = jest.fn((fn: (tx: unknown) => unknown) => {
    const response = responses[call++];
    const tx = {
      select: () => ({
        from: () => ({
          where: () => ({
            orderBy: () => Promise.resolve(response),
            limit: () => Promise.resolve(response),
          }),
        }),
      }),
      insert: () => ({
        values: (values: Record<string, unknown>) => {
          inserted.push(values);
          if (response instanceof Error) throw response;
          return { returning: () => Promise.resolve(response) };
        },
      }),
      update: () => ({
        set: (values: Record<string, unknown>) => {
          updated.push(values);
          return {
            where: () => ({
              returning: () => Promise.resolve(response),
              then: (resolve: (value: unknown) => void) => resolve(undefined),
            }),
          };
        },
      }),
      delete: () => ({
        where: () => ({ returning: () => Promise.resolve(response) }),
      }),
    };
    return Promise.resolve(fn(tx));
  });

  return {
    tenantContext: { withTenantTx } as unknown as TenantContextService,
    inserted,
    updated,
  };
}

describe('MessageTemplateService', () => {
  describe('create()', () => {
    it('records a WhatsApp template as pending, never approved', async () => {
      const { tenantContext, inserted } = makeTenantContext([[makeRow()]]);
      const service = new MessageTemplateService(tenantContext);

      await service.create(TENANT, {
        kind: 'whatsapp_template',
        name: 'order_shipped',
        language: 'en',
        category: 'UTILITY',
        body: 'Hi {{1}}',
        variables: [{ position: 1, label: 'Name', example: null }],
      });

      // The point of the feature: an unverified "approved" turns a refused
      // send into a mystery for the tenant.
      expect(inserted[0].approvalStatus).toBe('pending');
    });

    it('records a canned reply as local — it never goes through review', async () => {
      const { tenantContext, inserted } = makeTenantContext([
        [makeRow({ kind: 'canned_reply' })],
      ]);
      const service = new MessageTemplateService(tenantContext);

      await service.create(TENANT, {
        kind: 'canned_reply',
        name: 'Opening hours',
        language: 'en',
        category: null,
        body: 'We are open 9-6.',
        variables: [],
      });

      expect(inserted[0].approvalStatus).toBe('local');
    });

    it('refuses a body whose placeholders skip a position', async () => {
      const { tenantContext } = makeTenantContext([[makeRow()]]);
      const service = new MessageTemplateService(tenantContext);

      await expect(
        service.create(TENANT, {
          kind: 'canned_reply',
          name: 'Broken',
          language: 'en',
          category: null,
          body: 'Hi {{1}}, order {{3}}',
          variables: [],
        }),
      ).rejects.toBeInstanceOf(TemplateBodyError);
    });

    it('drops a label for a placeholder the body does not contain', async () => {
      const { tenantContext, inserted } = makeTenantContext([[makeRow()]]);
      const service = new MessageTemplateService(tenantContext);

      await service.create(TENANT, {
        kind: 'canned_reply',
        name: 'One value',
        language: 'en',
        category: null,
        body: 'Hi {{1}}',
        variables: [
          { position: 1, label: 'Name', example: null },
          { position: 2, label: 'Leftover', example: null },
        ],
      });

      // Otherwise the console keeps asking for a value that goes nowhere.
      expect(inserted[0].variables).toEqual([
        { position: 1, label: 'Name', example: null },
      ]);
    });

    it('labels a placeholder the tenant gave no label for rather than refusing the save', async () => {
      const { tenantContext, inserted } = makeTenantContext([[makeRow()]]);
      const service = new MessageTemplateService(tenantContext);

      await service.create(TENANT, {
        kind: 'canned_reply',
        name: 'Unlabelled',
        language: 'en',
        category: null,
        body: 'Hi {{1}}, order {{2}}',
        variables: [{ position: 1, label: 'Name', example: null }],
      });

      expect(inserted[0].variables).toEqual([
        { position: 1, label: 'Name', example: null },
        { position: 2, label: 'Value 2', example: null },
      ]);
    });

    // The shape matters: Drizzle does not rethrow the driver error, it wraps
    // it and hangs the pg error off `.cause`. A double that puts `code` at
    // the top level is the reason this 409 was dead code in production while
    // this test passed.
    it('turns a duplicate name into a 409 rather than a 500', async () => {
      const duplicate = Object.assign(new Error('Failed query'), {
        cause: Object.assign(new Error('duplicate key'), { code: '23505' }),
      });
      const { tenantContext } = makeTenantContext([duplicate]);
      const service = new MessageTemplateService(tenantContext);

      await expect(
        service.create(TENANT, {
          kind: 'canned_reply',
          name: 'Taken',
          language: 'en',
          category: null,
          body: 'Hello',
          variables: [],
        }),
      ).rejects.toBeInstanceOf(ConflictException);
    });
  });

  describe('update()', () => {
    it('sends an approved WhatsApp template back to pending when its body changes', async () => {
      const { tenantContext, updated } = makeTenantContext([
        [makeRow()], // require() -> existing
        [makeRow({ body: 'Hi {{1}}, your order {{2}} is delayed.' })],
      ]);
      const service = new MessageTemplateService(tenantContext);

      await service.update(TENANT, TEMPLATE_ID, {
        body: 'Hi {{1}}, your order {{2}} is delayed.',
      });

      // Meta approved specific words; sending different ones under an
      // approved name is what gets a WABA flagged.
      expect(updated[0].approvalStatus).toBe('pending');
      expect(updated[0].syncedAt).toBeNull();
    });

    it('leaves approval alone when only the category changes', async () => {
      const { tenantContext, updated } = makeTenantContext([
        [makeRow()],
        [makeRow({ category: 'MARKETING' })],
      ]);
      const service = new MessageTemplateService(tenantContext);

      await service.update(TENANT, TEMPLATE_ID, { category: 'MARKETING' });

      expect(updated[0].approvalStatus).toBeUndefined();
    });

    it('leaves a canned reply usable after an edit — it has no approval to lose', async () => {
      const { tenantContext, updated } = makeTenantContext([
        [makeRow({ kind: 'canned_reply', approvalStatus: 'local' })],
        [makeRow({ kind: 'canned_reply', approvalStatus: 'local' })],
      ]);
      const service = new MessageTemplateService(tenantContext);

      await service.update(TENANT, TEMPLATE_ID, { body: 'We are open 10-6.' });

      expect(updated[0].approvalStatus).toBeUndefined();
    });

    it('404s on a template belonging to another tenant', async () => {
      const { tenantContext } = makeTenantContext([[]]);
      const service = new MessageTemplateService(tenantContext);

      await expect(
        service.update(TENANT, TEMPLATE_ID, { body: 'Hello' }),
      ).rejects.toBeInstanceOf(NotFoundException);
    });
  });

  describe('remove()', () => {
    it('404s when nothing was deleted', async () => {
      const { tenantContext } = makeTenantContext([[]]);
      const service = new MessageTemplateService(tenantContext);

      await expect(service.remove(TENANT, TEMPLATE_ID)).rejects.toBeInstanceOf(
        NotFoundException,
      );
    });
  });
});
