import { NotFoundException } from '@nestjs/common';
import type { TenantContextService } from '../tenant-context/tenant-context.service';
import type { MessageTemplateService } from '../templates/message-template.service';
import { CampaignService, CampaignTemplateGateError } from './campaign.service';
import type { SegmentService } from './segment.service';

const TENANT = '11111111-1111-1111-1111-111111111111';
const SEGMENT_ID = '22222222-2222-2222-2222-222222222222';
const TEMPLATE_ID = '33333333-3333-3333-3333-333333333333';

function approvedTemplate(overrides: Record<string, unknown> = {}) {
  return {
    id: TEMPLATE_ID,
    kind: 'whatsapp_template',
    name: 'order_shipped',
    language: 'en',
    category: 'MARKETING',
    body: 'Hi {{1}}, your order shipped.',
    variables: [{ position: 1, label: 'Name', example: 'Sam' }],
    approvalStatus: 'approved',
    approvalDetail: null,
    syncedAt: new Date(),
    createdAt: new Date(),
    updatedAt: new Date(),
    ...overrides,
  };
}

function campaignRow(overrides: Record<string, unknown> = {}) {
  return {
    id: '44444444-4444-4444-4444-444444444444',
    tenantId: TENANT,
    name: 'Spring sale',
    segmentId: SEGMENT_ID,
    templateId: TEMPLATE_ID,
    templateValues: [
      { type: 'customer_field', field: 'name', fallback: 'there' },
    ],
    phoneNumberId: 'pn-1',
    status: 'draft',
    scheduledAt: null,
    startedAt: null,
    completedAt: null,
    recipientCount: 0,
    estimatedCostUsd: 0,
    spendCapUsd: 50,
    spentUsd: 0,
    pauseReason: null,
    failureReason: null,
    createdAt: new Date('2026-09-01T00:00:00Z'),
    updatedAt: new Date('2026-09-01T00:00:00Z'),
    ...overrides,
  };
}

function makeHarness(opts: {
  template?: Record<string, unknown>;
  insertResult?: unknown[];
  selectResult?: unknown[];
  segmentThrows?: boolean;
}) {
  const insertValues: Record<string, unknown>[] = [];

  const makeTx = () => ({
    insert: () => ({
      values: (values: Record<string, unknown>) => {
        insertValues.push(values);
        return {
          returning: () =>
            Promise.resolve(opts.insertResult ?? [campaignRow()]),
        };
      },
    }),
    select: () => ({
      from: () => ({
        where: () => ({
          orderBy: () => ({
            limit: () => ({
              offset: () => Promise.resolve(opts.selectResult ?? []),
              // Also usable directly (no orderBy chain) for get().
              then: (...args: unknown[]) =>
                (
                  Promise.resolve(
                    opts.selectResult ?? [],
                  ) as unknown as Promise<unknown>
                ).then(...(args as [never, never])),
            }),
          }),
          limit: () => Promise.resolve(opts.selectResult ?? []),
        }),
      }),
    }),
  });

  const withTenantTx = jest.fn((fn: (tx: unknown) => unknown) => fn(makeTx()));
  const tenantContext = { withTenantTx } as unknown as TenantContextService;

  const require = jest.fn();
  if (opts.segmentThrows) {
    require.mockRejectedValue(new NotFoundException('no segment'));
  } else {
    require.mockResolvedValue({ id: SEGMENT_ID });
  }
  const segments = { require } as unknown as SegmentService;

  const templateRequire = jest
    .fn()
    .mockResolvedValue(approvedTemplate(opts.template));
  const templates = {
    require: templateRequire,
  } as unknown as MessageTemplateService;

  return {
    tenantContext,
    insertValues,
    segments,
    templates,
    templateRequire,
    require,
  };
}

/**
 * The lifecycle collaborators `create()` never touches. Supplied so this
 * spec constructs the real service rather than a service with holes in it —
 * `CampaignService`'s own lifecycle behaviour is covered separately in
 * campaign-lifecycle.service.spec.ts.
 */
function lifecycleStubs() {
  return [
    {} as never, // CampaignEligibilityService
    {} as never, // SegmentResolverService
    {} as never, // CampaignSendSchedulerService
    { campaignDefaultSpendCapUsd: 50 } as never, // AppConfigService
    { now: () => new Date('2026-09-22T00:00:00Z') } as never, // Clock
  ] as const;
}

describe('CampaignService.create — template gate (D2)', () => {
  it('creates a draft campaign when the template is approved MARKETING/UTILITY and values match', async () => {
    const harness = makeHarness({ insertResult: [campaignRow()] });
    const service = new CampaignService(
      harness.tenantContext,
      harness.templates,
      harness.segments,
      ...lifecycleStubs(),
    );

    const result = await service.create(TENANT, {
      name: 'Spring sale',
      segmentId: SEGMENT_ID,
      templateId: TEMPLATE_ID,
      templateValues: [
        { type: 'customer_field', field: 'name', fallback: 'there' },
      ],
      phoneNumberId: 'pn-1',
    });

    expect(result.status).toBe('draft');
    expect(harness.insertValues[0]).toMatchObject({
      tenantId: TENANT,
      segmentId: SEGMENT_ID,
      templateId: TEMPLATE_ID,
    });
  });

  it('rejects a canned_reply template', async () => {
    const harness = makeHarness({ template: { kind: 'canned_reply' } });
    const service = new CampaignService(
      harness.tenantContext,
      harness.templates,
      harness.segments,
      ...lifecycleStubs(),
    );

    await expect(
      service.create(TENANT, {
        name: 'x',
        segmentId: SEGMENT_ID,
        templateId: TEMPLATE_ID,
        templateValues: [],
        phoneNumberId: 'pn-1',
      }),
    ).rejects.toThrow(CampaignTemplateGateError);
    expect(harness.insertValues).toHaveLength(0);
  });

  it.each(['pending', 'rejected', 'paused', 'disabled', 'local'])(
    'rejects a template with approvalStatus=%s, quoting approvalDetail',
    async (approvalStatus) => {
      const harness = makeHarness({
        template: { approvalStatus, approvalDetail: 'Meta says no' },
      });
      const service = new CampaignService(
        harness.tenantContext,
        harness.templates,
        harness.segments,
        ...lifecycleStubs(),
      );

      await expect(
        service.create(TENANT, {
          name: 'x',
          segmentId: SEGMENT_ID,
          templateId: TEMPLATE_ID,
          templateValues: [
            { type: 'customer_field', field: 'name', fallback: 'there' },
          ],
          phoneNumberId: 'pn-1',
        }),
      ).rejects.toThrow(/Meta says no/);
    },
  );

  it('rejects an AUTHENTICATION-category template', async () => {
    const harness = makeHarness({ template: { category: 'AUTHENTICATION' } });
    const service = new CampaignService(
      harness.tenantContext,
      harness.templates,
      harness.segments,
      ...lifecycleStubs(),
    );

    await expect(
      service.create(TENANT, {
        name: 'x',
        segmentId: SEGMENT_ID,
        templateId: TEMPLATE_ID,
        templateValues: [
          { type: 'customer_field', field: 'name', fallback: 'there' },
        ],
        phoneNumberId: 'pn-1',
      }),
    ).rejects.toThrow(CampaignTemplateGateError);
  });

  it('accepts a UTILITY-category template', async () => {
    const harness = makeHarness({ template: { category: 'UTILITY' } });
    const service = new CampaignService(
      harness.tenantContext,
      harness.templates,
      harness.segments,
      ...lifecycleStubs(),
    );

    await expect(
      service.create(TENANT, {
        name: 'x',
        segmentId: SEGMENT_ID,
        templateId: TEMPLATE_ID,
        templateValues: [
          { type: 'customer_field', field: 'name', fallback: 'there' },
        ],
        phoneNumberId: 'pn-1',
      }),
    ).resolves.toBeDefined();
  });

  it('rejects a template_values length mismatch', async () => {
    const harness = makeHarness({});
    const service = new CampaignService(
      harness.tenantContext,
      harness.templates,
      harness.segments,
      ...lifecycleStubs(),
    );

    await expect(
      service.create(TENANT, {
        name: 'x',
        segmentId: SEGMENT_ID,
        templateId: TEMPLATE_ID,
        templateValues: [],
        phoneNumberId: 'pn-1',
      }),
    ).rejects.toThrow(/takes 1 value/);
  });

  it('404s before any write when the segment does not belong to this tenant', async () => {
    const harness = makeHarness({ segmentThrows: true });
    const service = new CampaignService(
      harness.tenantContext,
      harness.templates,
      harness.segments,
      ...lifecycleStubs(),
    );

    await expect(
      service.create(TENANT, {
        name: 'x',
        segmentId: SEGMENT_ID,
        templateId: TEMPLATE_ID,
        templateValues: [
          { type: 'customer_field', field: 'name', fallback: 'there' },
        ],
        phoneNumberId: 'pn-1',
      }),
    ).rejects.toThrow(NotFoundException);
    expect(harness.templateRequire).not.toHaveBeenCalled();
    expect(harness.insertValues).toHaveLength(0);
  });
});
