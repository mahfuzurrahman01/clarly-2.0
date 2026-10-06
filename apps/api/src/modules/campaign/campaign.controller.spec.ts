import { ZodValidationPipe } from '../../common/zod-validation.pipe';
import type { TenantAuthContext } from '../auth/jwt-claims';
import { CampaignController } from './campaign.controller';
import type { CampaignStatsService } from './campaign-stats.service';
import {
  createCampaignBodySchema,
  listCampaignRecipientsQuerySchema,
  scheduleCampaignBodySchema,
  updateCampaignBodySchema,
} from './campaign.dto.zod';
import type { CampaignService } from './campaign.service';

const TENANT = '00000000-0000-0000-0000-00000000000a';
const USER_ID = '11111111-1111-1111-1111-111111111111';
const CAMPAIGN_ID = '22222222-2222-2222-2222-222222222222';
const SEGMENT_ID = '33333333-3333-3333-3333-333333333333';
const TEMPLATE_ID = '44444444-4444-4444-4444-444444444444';

const auth = {
  tenantId: TENANT,
  userId: USER_ID,
  role: 'admin',
} as TenantAuthContext;
const noopAudit = { describe: jest.fn() };

function campaignRecord(overrides: Record<string, unknown> = {}) {
  return {
    id: CAMPAIGN_ID,
    tenantId: TENANT,
    name: 'Spring sale',
    segmentId: SEGMENT_ID,
    templateId: TEMPLATE_ID,
    templateValues: [],
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

function makeHarness(statsResult: unknown = { campaignId: CAMPAIGN_ID }) {
  const create = jest.fn().mockResolvedValue(campaignRecord());
  const update = jest
    .fn()
    .mockResolvedValue(campaignRecord({ name: 'Autumn' }));
  const list = jest
    .fn()
    .mockResolvedValue({ campaigns: [campaignRecord()], total: 1 });
  const require = jest.fn().mockResolvedValue(campaignRecord());
  const schedule = jest
    .fn()
    .mockResolvedValue(campaignRecord({ status: 'scheduled' }));
  const pause = jest
    .fn()
    .mockResolvedValue(campaignRecord({ status: 'paused_manual' }));
  const resume = jest
    .fn()
    .mockResolvedValue(campaignRecord({ status: 'sending' }));
  const cancel = jest
    .fn()
    .mockResolvedValue(campaignRecord({ status: 'canceled' }));

  const forCampaign = jest.fn().mockResolvedValue(statsResult);
  const listRecipients = jest.fn().mockResolvedValue([]);

  const controller = new CampaignController(
    {
      create,
      update,
      list,
      require,
      schedule,
      pause,
      resume,
      cancel,
    } as unknown as CampaignService,
    { forCampaign, listRecipients } as unknown as CampaignStatsService,
  );

  return {
    controller,
    create,
    update,
    list,
    require,
    schedule,
    pause,
    resume,
    cancel,
    forCampaign,
    listRecipients,
  };
}

describe('CampaignController', () => {
  it('POST / creates a campaign, attributing the calling user', async () => {
    const { controller, create } = makeHarness();

    await controller.create(
      auth,
      {
        name: 'Spring sale',
        segmentId: SEGMENT_ID,
        templateId: TEMPLATE_ID,
        templateValues: [],
        phoneNumberId: 'pn-1',
      },
      noopAudit,
    );

    expect(create).toHaveBeenCalledWith(TENANT, {
      name: 'Spring sale',
      segmentId: SEGMENT_ID,
      templateId: TEMPLATE_ID,
      templateValues: [],
      phoneNumberId: 'pn-1',
      spendCapUsd: undefined,
      createdBy: USER_ID,
    });
  });

  it('POST / rejects an invalid body (bad segmentId) before the service is called', () => {
    const pipe = new ZodValidationPipe(createCampaignBodySchema);
    expect(() =>
      pipe.transform({
        name: 'x',
        segmentId: 'not-a-uuid',
        templateId: TEMPLATE_ID,
        phoneNumberId: 'pn-1',
      }),
    ).toThrow();
  });

  it('GET / lists campaigns for the calling tenant with the parsed pagination', async () => {
    const { controller, list } = makeHarness();
    await controller.list(auth, { limit: 20, offset: 0 });
    expect(list).toHaveBeenCalledWith(TENANT, { limit: 20, offset: 0 });
  });

  it('GET /:id returns the campaign (404 is require()`s job)', async () => {
    const { controller, require } = makeHarness();
    await controller.get(auth, CAMPAIGN_ID);
    expect(require).toHaveBeenCalledWith(TENANT, CAMPAIGN_ID);
  });

  it('PUT /:id edits a draft', async () => {
    const { controller, update } = makeHarness();
    await controller.update(auth, CAMPAIGN_ID, { name: 'Autumn' }, noopAudit);
    expect(update).toHaveBeenCalledWith(TENANT, CAMPAIGN_ID, {
      name: 'Autumn',
    });
  });

  it('PUT /:id rejects an invalid body before the service is called', () => {
    const pipe = new ZodValidationPipe(updateCampaignBodySchema);
    expect(() => pipe.transform({ spendCapUsd: -1 })).toThrow();
  });
});

// F19 (D8, D9): the lifecycle verbs. One case per route, plus an explicit
// invalid-body case per write route — F20 had no controller spec at all,
// which is exactly why both its P1s reached review.
describe('CampaignController — lifecycle', () => {
  it('POST /:id/schedule passes the requested time through', async () => {
    const { controller, schedule } = makeHarness();
    const sendAt = new Date('2026-10-01T09:00:00Z');

    await controller.schedule(auth, CAMPAIGN_ID, { sendAt }, noopAudit);
    expect(schedule).toHaveBeenCalledWith(TENANT, CAMPAIGN_ID, sendAt);
  });

  it('POST /:id/schedule with no body means "send now"', async () => {
    const { controller, schedule } = makeHarness();
    await controller.schedule(auth, CAMPAIGN_ID, {}, noopAudit);
    expect(schedule).toHaveBeenCalledWith(TENANT, CAMPAIGN_ID, null);
  });

  it('POST /:id/schedule rejects an unparseable sendAt before the service is called', () => {
    const pipe = new ZodValidationPipe(scheduleCampaignBodySchema);
    expect(() => pipe.transform({ sendAt: 'whenever' })).toThrow();
  });

  it.each([
    ['pause', 'paused_manual'],
    ['resume', 'sending'],
    ['cancel', 'canceled'],
  ] as const)(
    'POST /:id/%s scopes to the calling tenant',
    async (verb, status) => {
      const harness = makeHarness();
      const result = await harness.controller[verb](
        auth,
        CAMPAIGN_ID,
        noopAudit,
      );

      expect(harness[verb]).toHaveBeenCalledWith(TENANT, CAMPAIGN_ID);
      expect(result.status).toBe(status);
    },
  );
});

describe('CampaignController — reads (D5)', () => {
  it('GET /:id/stats returns the aggregate', async () => {
    const { controller, forCampaign } = makeHarness();
    await controller.statsFor(auth, CAMPAIGN_ID);
    expect(forCampaign).toHaveBeenCalledWith(TENANT, CAMPAIGN_ID);
  });

  it("GET /:id/stats 404s another tenant's campaign, indistinguishably from one that does not exist", async () => {
    const { controller } = makeHarness(null);
    await expect(controller.statsFor(auth, CAMPAIGN_ID)).rejects.toThrow(
      /not found/,
    );
  });

  it('GET /:id/recipients 404s before reading any recipient row', async () => {
    const { controller, require, listRecipients } = makeHarness();
    require.mockRejectedValueOnce(new Error('Campaign not found'));

    await expect(
      controller.recipients(auth, CAMPAIGN_ID, { limit: 20, offset: 0 }),
    ).rejects.toThrow();
    expect(listRecipients).not.toHaveBeenCalled();
  });

  it('GET /:id/recipients passes the parsed pagination and status filter through', async () => {
    const { controller, listRecipients } = makeHarness();
    await controller.recipients(auth, CAMPAIGN_ID, {
      limit: 50,
      offset: 10,
      status: 'pending',
    });

    expect(listRecipients).toHaveBeenCalledWith(TENANT, CAMPAIGN_ID, {
      limit: 50,
      offset: 10,
      status: 'pending',
    });
  });

  it('GET /:id/recipients rejects a limit over 100 and an unknown status', () => {
    const pipe = new ZodValidationPipe(listCampaignRecipientsQuerySchema);
    expect(() => pipe.transform({ limit: '500' })).toThrow();
    expect(() => pipe.transform({ status: 'nonsense' })).toThrow();
  });
});
