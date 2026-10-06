// The shared half of every approved-template send (F26 D5).
//
// `TemplateReplyService` (human) and `DeliveryNotificationService`
// (automated) both run these guards, which is the point of the extraction:
// a second copy of the approval/category/consent/window logic is how those
// guards drift apart, and they are the guards that decide whether Meta bills
// the tenant for a policy violation.
import type { AppLoggerService } from '../core';
import type { CustomerConsentService } from '../customer/customer-consent.service';
import type { WhatsappNumberDirectory } from '../whatsapp/whatsapp-number-directory.service';
import type { BspAdapter } from '../whatsapp/ports/bsp-adapter.port';
import type { MessageTemplateService } from './message-template.service';
import { MetaGraphError } from '../meta-graph/meta-graph.error';
import { TemplateSendService } from './template-send.service';

const TENANT = 'tenant-a';
const TEMPLATE_ID = '22222222-2222-4333-8444-555555555555';

const conversation = {
  id: 'conv-1',
  customerPhone: '+966500000001',
  channel: 'whatsapp',
  channelAccountId: 'pn-1',
};

function template(overrides: Record<string, unknown> = {}) {
  return {
    id: TEMPLATE_ID,
    kind: 'whatsapp_template',
    name: 'shipment_update',
    language: 'en',
    category: 'utility',
    body: 'Your parcel {{1}} is now {{2}}.',
    approvalStatus: 'approved',
    approvalDetail: null,
    ...overrides,
  };
}

function makeService(
  options: {
    template?: Record<string, unknown> | null;
    optedOut?: boolean;
    numbers?: Array<{ id: string; phoneNumberId: string }>;
    /** What the BSP lists for the number; `undefined` = the template exists and is APPROVED. */
    listing?: Array<Record<string, unknown>> | null | Error;
  } = {},
) {
  const get = jest
    .fn()
    .mockResolvedValue(
      options.template === null ? null : template(options.template ?? {}),
    );
  const isOptedOut = jest.fn().mockResolvedValue(options.optedOut ?? false);
  const listForTenant = jest
    .fn()
    .mockResolvedValue(
      options.numbers ?? [{ id: 'n1', phoneNumberId: 'pn-1' }],
    );
  const sendTemplateMessage = jest
    .fn()
    .mockResolvedValue({ bspMessageId: 'wamid.X' });
  const listTemplates = jest.fn();
  if (options.listing instanceof Error) {
    listTemplates.mockRejectedValue(options.listing);
  } else {
    listTemplates.mockResolvedValue(
      options.listing === undefined
        ? [
            {
              name: 'shipment_update',
              language: 'en',
              status: 'APPROVED',
              category: 'UTILITY',
              reason: null,
            },
          ]
        : options.listing,
    );
  }

  const service = new TemplateSendService(
    { get } as unknown as MessageTemplateService,
    { listForTenant } as unknown as WhatsappNumberDirectory,
    { isOptedOut } as unknown as CustomerConsentService,
    { sendTemplateMessage, listTemplates } as unknown as BspAdapter,
    {
      log: jest.fn(),
      warn: jest.fn(),
      error: jest.fn(),
      debug: jest.fn(),
    } as unknown as AppLoggerService,
  );

  return { service, sendTemplateMessage, isOptedOut, listTemplates };
}

const input = {
  tenantId: TENANT,
  conversation,
  templateId: TEMPLATE_ID,
  values: ['AWB-1', 'out for delivery'],
};

describe('TemplateSendService.prepare', () => {
  it('renders the body and resolves the sending number', async () => {
    const { service } = makeService();

    const result = await service.prepare(input);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.plan.text).toBe('Your parcel AWB-1 is now out for delivery.');
    expect(result.plan.phoneNumberId).toBe('pn-1');
  });

  it.each([
    ['not_found', { template: null }],
    ['not_a_whatsapp_template', { template: { kind: 'canned_reply' } }],
    ['not_approved', { template: { approvalStatus: 'pending' } }],
    ['opted_out', { optedOut: true }],
  ] as const)('refuses with reason %s', async (reason, options) => {
    const { service, sendTemplateMessage } = makeService(options);

    const result = await service.prepare(input);

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe(reason);
    expect(sendTemplateMessage).not.toHaveBeenCalled();
  });

  // F26's one addition to the shared guards: Meta bills and enforces per
  // category, so a marketing template for a shipment update is a policy
  // violation as well as a mis-bill.
  it('enforces a required category when the caller pins one', async () => {
    const { service } = makeService({ template: { category: 'marketing' } });

    const result = await service.prepare({
      ...input,
      requireCategory: 'utility',
    });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe('wrong_category');
  });

  // A person choosing a template is choosing its category too.
  it('does not constrain the category when the caller pins none', async () => {
    const { service } = makeService({ template: { category: 'marketing' } });

    await expect(service.prepare(input)).resolves.toMatchObject({ ok: true });
  });

  it('refuses a value count that does not match the template', async () => {
    const { service } = makeService();

    const result = await service.prepare({ ...input, values: ['AWB-1'] });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    // Blank-filling would send "your parcel AWB-1 is now ." and look fine to
    // whoever sent it.
    expect(result.reason).toBe('invalid_values');
  });

  // Templates are a WhatsApp mechanism; Messenger and Instagram use message
  // tags, a different send with different rules.
  it('refuses a non-WhatsApp channel', async () => {
    const { service } = makeService();

    const result = await service.prepare({
      ...input,
      conversation: { ...conversation, channel: 'messenger' },
    });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe('unsupported_channel');
  });

  it('refuses rather than guesses when several numbers could have sent it', async () => {
    const { service } = makeService({
      numbers: [
        { id: 'n1', phoneNumberId: 'pn-1' },
        { id: 'n2', phoneNumberId: 'pn-2' },
      ],
    });

    const result = await service.prepare({
      ...input,
      conversation: { ...conversation, channelAccountId: null },
    });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe('ambiguous_sending_number');
  });

  it('refuses when the workspace has no number at all', async () => {
    const { service } = makeService({ numbers: [] });

    const result = await service.prepare({
      ...input,
      conversation: { ...conversation, channelAccountId: null },
    });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe('no_sending_number');
  });
});

describe('TemplateSendService.prepare — live check against the sending number WABA (ISSUE-002)', () => {
  const listed = (overrides: Record<string, unknown> = {}) => ({
    name: 'shipment_update',
    language: 'en',
    status: 'APPROVED',
    category: 'UTILITY',
    reason: null,
    ...overrides,
  });

  it('refuses a locally-approved template that Meta does not have, before any send', async () => {
    const { service, sendTemplateMessage, listTemplates } = makeService({
      listing: [listed({ name: 'something_else' })],
    });

    const result = await service.prepare(input);

    expect(listTemplates).toHaveBeenCalledWith('pn-1');
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe('not_on_whatsapp');
    expect(result.message).toContain('shipment_update');
    expect(sendTemplateMessage).not.toHaveBeenCalled();
  });

  it('names the languages Meta does have when only the language differs', async () => {
    const { service } = makeService({
      listing: [listed({ language: 'en_US' })],
    });

    const result = await service.prepare(input);

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe('not_on_whatsapp');
    expect(result.message).toContain('en_US');
  });

  it('refuses a template Meta lists but has not approved, with its status', async () => {
    const { service } = makeService({
      listing: [listed({ status: 'REJECTED', reason: 'INVALID_FORMAT' })],
    });

    const result = await service.prepare(input);

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe('not_on_whatsapp');
    expect(result.message).toContain('REJECTED');
  });

  it('matches the language case-insensitively', async () => {
    const { service } = makeService({
      listing: [listed({ language: 'EN' })],
    });

    expect((await service.prepare(input)).ok).toBe(true);
  });

  it('does not block the send when the adapter cannot report (null listing)', async () => {
    const { service } = makeService({ listing: null });

    expect((await service.prepare(input)).ok).toBe(true);
  });

  it('does not block the send when the listing call fails', async () => {
    const { service } = makeService({ listing: new Error('graph down') });

    expect((await service.prepare(input)).ok).toBe(true);
  });
});

describe('TemplateSendService.dispatch', () => {
  it('reports a successful send with the BSP message id', async () => {
    const { service, sendTemplateMessage } = makeService();
    const prepared = await service.prepare(input);
    if (!prepared.ok) throw new Error('expected a plan');

    const result = await service.dispatch({
      plan: prepared.plan,
      to: conversation.customerPhone,
      values: input.values,
      context: 'test',
    });

    expect(result).toEqual({
      delivered: true,
      bspMessageId: 'wamid.X',
      deliveryError: null,
    });
    expect(sendTemplateMessage).toHaveBeenCalledWith({
      phoneNumberId: 'pn-1',
      to: '+966500000001',
      templateName: 'shipment_update',
      language: 'en',
      bodyParameters: input.values,
    });
  });

  // Never throws for a send failure: a message that did not arrive is a real
  // event that belongs in the transcript marked as such, and both callers
  // need to record it rather than unwind.
  it('reports a failure instead of throwing', async () => {
    const { service, sendTemplateMessage } = makeService();
    sendTemplateMessage.mockRejectedValue(new Error('template not found'));
    const prepared = await service.prepare(input);
    if (!prepared.ok) throw new Error('expected a plan');

    const result = await service.dispatch({
      plan: prepared.plan,
      to: conversation.customerPhone,
      values: input.values,
      context: 'test',
    });

    expect(result.delivered).toBe(false);
    expect(result.deliveryError).toContain('template not found');
  });

  // ISSUE-002: the operator reads this in the console. Internal class names
  // and the HTTP plumbing are noise; the Meta code and message are the signal.
  it('strips internal adapter wording from the operator-facing error', async () => {
    const { service, sendTemplateMessage } = makeService();
    sendTemplateMessage.mockRejectedValue(
      new MetaGraphError(
        404,
        132001,
        null,
        'MetaCloudAdapter: send failed with HTTP 404: (#132001) Template name does not exist in the translation',
      ),
    );
    const prepared = await service.prepare(input);
    if (!prepared.ok) throw new Error('expected a plan');

    const result = await service.dispatch({
      plan: prepared.plan,
      to: conversation.customerPhone,
      values: input.values,
      context: 'test',
    });

    expect(result.deliveryError).toBe(
      'WhatsApp rejected the send (#132001): Template name does not exist in the translation',
    );
  });
});
