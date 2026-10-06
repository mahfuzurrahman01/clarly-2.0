import type { AppLoggerService } from '../core';
import type { WhatsappNumberDirectory } from '../whatsapp/whatsapp-number-directory.service';
import type { BspAdapter } from '../whatsapp/ports/bsp-adapter.port';
import type { MessageTemplateService } from './message-template.service';
import { TemplateSyncService } from './template-sync.service';

const TENANT = 'tenant-a';

function stored(overrides: Record<string, unknown> = {}) {
  return {
    id: 'template-1',
    kind: 'whatsapp_template',
    name: 'order_shipped',
    language: 'en',
    category: 'UTILITY',
    body: 'Hi {{1}}',
    variables: [],
    approvalStatus: 'pending',
    approvalDetail: null,
    wabaId: 'waba-1',
    syncedAt: null,
    createdAt: new Date(),
    updatedAt: new Date(),
    ...overrides,
  };
}

function makeService(options: {
  stored?: Record<string, unknown>[];
  listing?: unknown;
  numbers?: { id: string; phoneNumberId: string }[];
  /** F19 (D2): which WABA each connected number belongs to. */
  wabaIds?: Record<string, string | null>;
}) {
  const list = jest.fn().mockResolvedValue(options.stored ?? [stored()]);
  const recordApproval = jest.fn().mockResolvedValue(undefined);
  const listTemplates = jest
    .fn()
    .mockResolvedValue(options.listing === undefined ? [] : options.listing);
  const listForTenant = jest
    .fn()
    .mockResolvedValue(
      options.numbers ?? [{ id: 'n1', phoneNumberId: 'pn-1' }],
    );

  const wabaIdsByPhoneNumber = jest.fn().mockResolvedValue(
    new Map<string, string | null>(
      Object.entries(
        options.wabaIds ?? {
          'pn-1': 'waba-1',
          'pn-ok': 'waba-1',
          'pn-broken': 'waba-1',
        },
      ),
    ),
  );

  return {
    service: new TemplateSyncService(
      { list, recordApproval } as unknown as MessageTemplateService,
      {
        listForTenant,
        wabaIdsByPhoneNumber,
      } as unknown as WhatsappNumberDirectory,
      { listTemplates } as unknown as BspAdapter,
      { warn: jest.fn() } as unknown as AppLoggerService,
    ),
    recordApproval,
    listTemplates,
  };
}

describe('TemplateSyncService', () => {
  it('marks a template approved once WhatsApp says so', async () => {
    const { service, recordApproval } = makeService({
      listing: [
        {
          name: 'order_shipped',
          language: 'en',
          status: 'APPROVED',
          category: 'UTILITY',
          reason: null,
        },
      ],
    });

    const result = await service.sync(TENANT);

    expect(recordApproval).toHaveBeenCalledWith(
      TENANT,
      'template-1',
      'approved',
      null,
      expect.any(Date),
      'waba-1',
    );
    expect(result.updated).toBe(1);
  });

  it("records WhatsApp's rejection reason verbatim", async () => {
    const { service, recordApproval } = makeService({
      listing: [
        {
          name: 'order_shipped',
          language: 'en',
          status: 'REJECTED',
          category: 'UTILITY',
          reason: 'INVALID_FORMAT',
        },
      ],
    });

    await service.sync(TENANT);

    expect(recordApproval).toHaveBeenCalledWith(
      TENANT,
      'template-1',
      'rejected',
      'INVALID_FORMAT',
      expect.any(Date),
      'waba-1',
    );
  });

  // A status we cannot read must never unlock a send.
  it('treats an unrecognised WhatsApp status as pending, not approved', async () => {
    const { service, recordApproval } = makeService({
      stored: [stored({ approvalStatus: 'approved' })],
      listing: [
        {
          name: 'order_shipped',
          language: 'en',
          status: 'SOMETHING_NEW',
          category: null,
          reason: null,
        },
      ],
    });

    await service.sync(TENANT);

    expect(recordApproval).toHaveBeenCalledWith(
      TENANT,
      'template-1',
      'pending',
      null,
      expect.any(Date),
      'waba-1',
    );
  });

  it('writes nothing when the status has not changed', async () => {
    const { service, recordApproval } = makeService({
      stored: [stored({ approvalStatus: 'approved' })],
      listing: [
        {
          name: 'order_shipped',
          language: 'en',
          status: 'APPROVED',
          category: 'UTILITY',
          reason: null,
        },
      ],
    });

    const result = await service.sync(TENANT);

    expect(recordApproval).not.toHaveBeenCalled();
    expect(result.updated).toBe(0);
  });

  it('reports a stored name WhatsApp has never heard of without touching it', async () => {
    const { service, recordApproval } = makeService({
      stored: [stored({ approvalStatus: 'approved' })],
      listing: [
        {
          name: 'something_else',
          language: 'en',
          status: 'APPROVED',
          category: 'UTILITY',
          reason: null,
        },
      ],
    });

    const result = await service.sync(TENANT);

    // The usual cause is a typo at one end, not a template that vanished.
    expect(result.unknownToBsp).toEqual(['order_shipped (en)']);
    expect(recordApproval).not.toHaveBeenCalled();
  });

  // The failure this guards: silence and "no templates" look identical, and
  // treating the first as the second invalidates every approved template.
  it('changes nothing when no connected number can report', async () => {
    const { service, recordApproval } = makeService({
      stored: [stored({ approvalStatus: 'approved' })],
      listing: null,
    });

    const result = await service.sync(TENANT);

    expect(result.unreported).toBe(true);
    expect(result.unknownToBsp).toEqual([]);
    expect(recordApproval).not.toHaveBeenCalled();
  });

  it('does not lose the sync when one number is unreachable', async () => {
    const { service, recordApproval, listTemplates } = makeService({
      numbers: [
        { id: 'n1', phoneNumberId: 'pn-broken' },
        { id: 'n2', phoneNumberId: 'pn-ok' },
      ],
    });
    listTemplates
      .mockRejectedValueOnce(new Error('HTTP 401'))
      .mockResolvedValueOnce([
        {
          name: 'order_shipped',
          language: 'en',
          status: 'APPROVED',
          category: 'UTILITY',
          reason: null,
        },
      ]);

    const result = await service.sync(TENANT);

    expect(result.updated).toBe(1);
    expect(recordApproval).toHaveBeenCalled();
  });

  // F19 (D2): the sync is the only thing that knows which account reported a
  // template, so it is the only thing that can stamp `waba_id` — the column
  // the campaign eligibility gate compares the sending number against.
  describe('WABA stamping (F19 D2)', () => {
    it('records the WABA of the number whose listing reported the template', async () => {
      const { service, recordApproval } = makeService({
        stored: [stored({ wabaId: null })],
        numbers: [{ id: 'n1', phoneNumberId: 'pn-1' }],
        wabaIds: { 'pn-1': 'waba-7' },
        listing: [
          {
            name: 'order_shipped',
            language: 'en',
            status: 'APPROVED',
            category: 'UTILITY',
            reason: null,
          },
        ],
      });

      const result = await service.sync(TENANT);

      expect(recordApproval).toHaveBeenCalledWith(
        TENANT,
        'template-1',
        'approved',
        null,
        expect.any(Date),
        'waba-7',
      );
      expect(result.updated).toBe(1);
    });

    it('backfills the WABA of an already-approved template whose status did not change', async () => {
      const { service, recordApproval } = makeService({
        stored: [stored({ approvalStatus: 'approved', wabaId: null })],
        listing: [
          {
            name: 'order_shipped',
            language: 'en',
            status: 'APPROVED',
            category: 'UTILITY',
            reason: null,
          },
        ],
      });

      const result = await service.sync(TENANT);

      expect(result.updated).toBe(1);
      expect(recordApproval).toHaveBeenCalledWith(
        TENANT,
        'template-1',
        'approved',
        null,
        expect.any(Date),
        'waba-1',
      );
    });

    // Two accounts reporting the same name/language have no single answer.
    // Null blocks the send; a guess would send from the wrong account.
    it('stores null when two WABAs both report the same name and language', async () => {
      const { service, recordApproval } = makeService({
        stored: [stored({ approvalStatus: 'approved' })],
        numbers: [
          { id: 'n1', phoneNumberId: 'pn-a' },
          { id: 'n2', phoneNumberId: 'pn-b' },
        ],
        wabaIds: { 'pn-a': 'waba-1', 'pn-b': 'waba-2' },
        listing: [
          {
            name: 'order_shipped',
            language: 'en',
            status: 'APPROVED',
            category: 'UTILITY',
            reason: null,
          },
        ],
      });

      await service.sync(TENANT);

      expect(recordApproval).toHaveBeenCalledWith(
        TENANT,
        'template-1',
        'approved',
        null,
        expect.any(Date),
        null,
      );
    });

    it('is not confused by two numbers on the SAME WABA reporting it twice', async () => {
      const { service, recordApproval } = makeService({
        stored: [stored({ approvalStatus: 'approved' })],
        numbers: [
          { id: 'n1', phoneNumberId: 'pn-a' },
          { id: 'n2', phoneNumberId: 'pn-b' },
        ],
        wabaIds: { 'pn-a': 'waba-1', 'pn-b': 'waba-1' },
        listing: [
          {
            name: 'order_shipped',
            language: 'en',
            status: 'APPROVED',
            category: 'UTILITY',
            reason: null,
          },
        ],
      });

      const result = await service.sync(TENANT);

      expect(result.updated).toBe(0);
      expect(recordApproval).not.toHaveBeenCalled();
    });

    it('stores null when the reporting number has no WABA recorded', async () => {
      const { service, recordApproval } = makeService({
        stored: [stored({ approvalStatus: 'approved' })],
        wabaIds: { 'pn-1': null },
        listing: [
          {
            name: 'order_shipped',
            language: 'en',
            status: 'APPROVED',
            category: 'UTILITY',
            reason: null,
          },
        ],
      });

      await service.sync(TENANT);

      expect(recordApproval).toHaveBeenCalledWith(
        TENANT,
        'template-1',
        'approved',
        null,
        expect.any(Date),
        null,
      );
    });
  });

  it('does not call the BSP at all when the tenant has no WhatsApp templates', async () => {
    const { service, listTemplates } = makeService({ stored: [] });

    const result = await service.sync(TENANT);

    expect(listTemplates).not.toHaveBeenCalled();
    expect(result).toEqual({ updated: 0, unknownToBsp: [], unreported: false });
  });
});
