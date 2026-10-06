import { BadRequestException } from '@nestjs/common';
import type { AppLoggerService } from '../core';
import type { BspAdapter } from '../whatsapp/ports/bsp-adapter.port';
import type { WhatsappNumberDirectory } from '../whatsapp/whatsapp-number-directory.service';
import type {
  MessageTemplateRecord,
  MessageTemplateService,
} from './message-template.service';
import { TemplateSubmissionService } from './template-submission.service';

const TENANT = 'tenant-a';
const TEMPLATE_ID = 'template-1';

function makeTemplate(
  overrides: Partial<MessageTemplateRecord> = {},
): MessageTemplateRecord {
  return {
    id: TEMPLATE_ID,
    kind: 'whatsapp_template',
    name: 'order_shipped',
    language: 'en',
    category: 'UTILITY',
    body: 'Your order {{1}} ships {{2}}.',
    variables: [
      { position: 1, label: 'Order number', example: 'A-1024' },
      { position: 2, label: 'Ship date', example: 'Tuesday' },
    ],
    approvalStatus: 'pending',
    approvalDetail: null,
    syncedAt: null,
    createdAt: new Date('2026-01-01T00:00:00Z'),
    updatedAt: new Date('2026-01-01T00:00:00Z'),
    wabaId: null,
    ...overrides,
  };
}

function makeHarness(options: {
  template?: MessageTemplateRecord;
  numbers?: { phoneNumberId: string }[];
  submitTemplate?: jest.Mock;
}) {
  const recordApproval = jest.fn().mockResolvedValue(undefined);
  const templates = {
    require: jest.fn().mockResolvedValue(options.template ?? makeTemplate()),
    recordApproval,
  } as unknown as MessageTemplateService;

  const numbers = {
    listForTenant: jest
      .fn()
      .mockResolvedValue(options.numbers ?? [{ phoneNumberId: 'pn-1' }]),
  } as unknown as WhatsappNumberDirectory;

  const submitTemplate =
    options.submitTemplate ??
    jest.fn().mockResolvedValue({
      providerTemplateId: 'meta-1',
      status: 'PENDING',
      category: 'UTILITY',
    });
  const bspAdapter = { submitTemplate } as unknown as BspAdapter;

  const warn = jest.fn();
  const logger = { warn } as unknown as AppLoggerService;

  return {
    service: new TemplateSubmissionService(
      templates,
      numbers,
      bspAdapter,
      logger,
    ),
    recordApproval,
    submitTemplate,
    warn,
  };
}

describe('TemplateSubmissionService.submit()', () => {
  it('sends the body and one example per placeholder, in position order', async () => {
    const { service, submitTemplate } = makeHarness({});

    await service.submit(TENANT, TEMPLATE_ID);

    expect(submitTemplate).toHaveBeenCalledWith({
      phoneNumberId: 'pn-1',
      name: 'order_shipped',
      language: 'en',
      category: 'UTILITY',
      body: 'Your order {{1}} ships {{2}}.',
      bodyExamples: ['A-1024', 'Tuesday'],
    });
  });

  it('reports the provider id so a rejection can be appealed', async () => {
    const { service } = makeHarness({});

    await expect(service.submit(TENANT, TEMPLATE_ID)).resolves.toEqual({
      submitted: true,
      providerTemplateId: 'meta-1',
      unsupportedReason: null,
    });
  });

  // Acceptance for review is not approval. Writing `approved` here would let
  // a template send before WhatsApp ever ruled on it, which is exactly the
  // failure the approval column exists to prevent.
  it('records pending after a successful submission, never approved', async () => {
    const { service, recordApproval } = makeHarness({});

    await service.submit(TENANT, TEMPLATE_ID);

    expect(recordApproval).toHaveBeenCalledWith(
      TENANT,
      TEMPLATE_ID,
      'pending',
      null,
      expect.any(Date),
    );
  });

  // The port's null means "this adapter cannot submit". Treating it as
  // success would be the silently-succeeding placeholder this codebase
  // refuses — the stored status must stay untouched and say so.
  it('leaves the template untouched when the adapter cannot submit', async () => {
    const { service, recordApproval } = makeHarness({
      submitTemplate: jest.fn().mockResolvedValue(null),
    });

    const result = await service.submit(TENANT, TEMPLATE_ID);

    expect(result.submitted).toBe(false);
    expect(result.unsupportedReason).toContain('could register the template');
    expect(recordApproval).not.toHaveBeenCalled();
  });

  it('reports the no-connected-number case distinctly', async () => {
    const { service, submitTemplate } = makeHarness({ numbers: [] });

    const result = await service.submit(TENANT, TEMPLATE_ID);

    expect(result.submitted).toBe(false);
    expect(result.unsupportedReason).toContain('no connected WhatsApp number');
    expect(submitTemplate).not.toHaveBeenCalled();
  });

  // One account rejecting must not cost the tenant a second account that
  // would have accepted, but the reason must still be recorded.
  it('tries the next number when one throws, and logs why', async () => {
    const submitTemplate = jest
      .fn()
      .mockRejectedValueOnce(new Error('HTTP 400: name already exists'))
      .mockResolvedValueOnce({
        providerTemplateId: 'meta-2',
        status: 'PENDING',
        category: 'UTILITY',
      });
    const { service, warn } = makeHarness({
      numbers: [{ phoneNumberId: 'pn-1' }, { phoneNumberId: 'pn-2' }],
      submitTemplate,
    });

    const result = await service.submit(TENANT, TEMPLATE_ID);

    expect(result).toMatchObject({
      submitted: true,
      providerTemplateId: 'meta-2',
    });
    expect(warn).toHaveBeenCalledWith(
      expect.stringContaining('name already exists'),
      'TemplateSubmissionService',
    );
  });

  it('does not submit to a second account once one accepts', async () => {
    const { service, submitTemplate } = makeHarness({
      numbers: [{ phoneNumberId: 'pn-1' }, { phoneNumberId: 'pn-2' }],
    });

    await service.submit(TENANT, TEMPLATE_ID);

    expect(submitTemplate).toHaveBeenCalledTimes(1);
  });

  it('rejects a canned reply — it has no WhatsApp counterpart', async () => {
    const { service, submitTemplate } = makeHarness({
      template: makeTemplate({
        kind: 'canned_reply',
        approvalStatus: 'local',
      }),
    });

    await expect(service.submit(TENANT, TEMPLATE_ID)).rejects.toBeInstanceOf(
      BadRequestException,
    );
    expect(submitTemplate).not.toHaveBeenCalled();
  });

  // WhatsApp treats a duplicate name+language as a conflict, not an update,
  // so resubmitting an approved template just fails opaquely.
  it('rejects resubmitting an already-approved template', async () => {
    const { service, submitTemplate } = makeHarness({
      template: makeTemplate({ approvalStatus: 'approved' }),
    });

    await expect(service.submit(TENANT, TEMPLATE_ID)).rejects.toBeInstanceOf(
      BadRequestException,
    );
    expect(submitTemplate).not.toHaveBeenCalled();
  });

  // Turns an opaque Graph 400 into a message naming the placeholder at fault.
  it('rejects a placeholder with no example, naming which one', async () => {
    const { service, submitTemplate } = makeHarness({
      template: makeTemplate({
        variables: [
          { position: 1, label: 'Order number', example: 'A-1024' },
          { position: 2, label: 'Ship date', example: null },
        ],
      }),
    });

    await expect(service.submit(TENANT, TEMPLATE_ID)).rejects.toThrow(
      /\{\{2\}\}/,
    );
    expect(submitTemplate).not.toHaveBeenCalled();
  });

  it('sends no examples for a body with no placeholders', async () => {
    const { service, submitTemplate } = makeHarness({
      template: makeTemplate({
        body: 'Thanks for getting in touch.',
        variables: [],
      }),
    });

    await service.submit(TENANT, TEMPLATE_ID);

    expect(submitTemplate).toHaveBeenCalledWith(
      expect.objectContaining({ bodyExamples: [] }),
    );
  });

  it('falls back to UTILITY when the template has no category', async () => {
    const { service, submitTemplate } = makeHarness({
      template: makeTemplate({ category: null }),
    });

    await service.submit(TENANT, TEMPLATE_ID);

    expect(submitTemplate).toHaveBeenCalledWith(
      expect.objectContaining({ category: 'UTILITY' }),
    );
  });
});
