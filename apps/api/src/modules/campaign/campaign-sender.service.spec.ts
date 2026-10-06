// F19 (D3, D9): one recipient, end to end.
//
// The cases here are the safety argument, not coverage padding:
//   - a rate limit DEFERS and leaves the row untouched,
//   - consent is re-checked per recipient and produces a VISIBLE skip,
//   - the spend cap is evaluated BEFORE the claim, so pausing leaves the row
//     pending,
//   - exactly at the cap sends and one cent over pauses,
//   - the claim is what decides who sends, so a row someone else holds is
//     never messaged twice,
//   - `spent_usd` moves in the SAME transaction as the status flip.
import type { ConversationService } from '../conversation/conversation.service';
import type { AppLoggerService, Clock } from '../core';
import type { TenantContextService } from '../tenant-context/tenant-context.service';
import type { BspAdapter } from '../whatsapp/ports/bsp-adapter.port';
import type { CampaignRateLimiter } from './campaign-rate-limiter.service';
import {
  campaignClientMessageId,
  CampaignSenderService,
  isSendablePhone,
  renderParameters,
  type CampaignSendContext,
} from './campaign-sender.service';
import { CampaignDeferredError, CampaignPausedError } from './campaign.errors';

const TENANT = '11111111-1111-1111-1111-111111111111';
const CAMPAIGN = '44444444-4444-4444-4444-444444444444';
const RECIPIENT = '55555555-5555-5555-5555-555555555555';
const NOW = new Date('2026-09-22T12:00:00.000Z');

/** A UAE number: MARKETING_RATE_USD_BY_PREFIX['971'] = 0.0344. */
const UAE_PHONE = '+971501234567';
const UAE_RATE = 0.0344;

function context(
  overrides: Partial<CampaignSendContext> = {},
): CampaignSendContext {
  return {
    tenantId: TENANT,
    campaignId: CAMPAIGN,
    phoneNumberId: 'pn-1',
    templateName: 'spring_sale',
    templateLanguage: 'en',
    templateBody: 'Hi {{1}}, spring sale is on.',
    templateValues: [
      { type: 'customer_field', field: 'name', fallback: 'there' },
    ],
    launchedBy: 'user-1',
    messagingLimitTier: 'TIER_1K',
    qualityRating: 'GREEN',
    ...overrides,
  };
}

interface RowOverrides {
  status?: string;
  phone?: string;
  customerName?: string | null;
  optedOutAt?: Date | null;
  marketingOptedOutAt?: Date | null;
  spentUsd?: number;
  spendCapUsd?: number;
}

function harness(
  opts: {
    row?: RowOverrides | null;
    claimed?: boolean;
    throughputAllowed?: boolean;
    dailyAllowed?: boolean;
    sendThrows?: Error;
  } = {},
) {
  const row =
    opts.row === null
      ? null
      : {
          status: 'pending',
          phone: UAE_PHONE,
          customerName: 'Sam',
          optedOutAt: null,
          marketingOptedOutAt: null,
          spentUsd: 0,
          spendCapUsd: 50,
          ...opts.row,
        };

  /** Every `.set()` the code issued, in order. */
  const writes: { values: Record<string, unknown> }[] = [];
  /** How many transactions were opened — the spend-cap invariant is asserted on this. */
  const transactions: number[] = [];

  const makeTx = (txIndex: number) => ({
    select: () => ({
      from: () => {
        const chain = {
          innerJoin: () => chain,
          where: () => ({
            limit: () => Promise.resolve(row ? [row] : []),
          }),
        };
        return chain;
      },
    }),
    update: () => ({
      set: (values: Record<string, unknown>) => {
        writes.push({ values });
        transactions.push(txIndex);
        const result = {
          returning: () =>
            Promise.resolve(opts.claimed === false ? [] : [{ id: RECIPIENT }]),
          then: (...args: unknown[]) =>
            (Promise.resolve([]) as unknown as Promise<unknown>).then(
              ...(args as [never, never]),
            ),
        };
        return { where: () => result };
      },
    }),
  });

  let txIndex = 0;
  const withTenantTx = jest.fn((fn: (tx: unknown) => unknown) =>
    fn(makeTx(txIndex++)),
  );
  const tenantContext = { withTenantTx } as unknown as TenantContextService;

  const throughput = jest
    .fn()
    .mockResolvedValue(
      opts.throughputAllowed === false
        ? { allowed: false, retryAfterMs: 500, reason: 'throughput' }
        : { allowed: true },
    );
  const dailyConversation = jest
    .fn()
    .mockResolvedValue(
      opts.dailyAllowed === false
        ? { allowed: false, retryAfterMs: 3_600_000, reason: '24h limit' }
        : { allowed: true },
    );
  const limiter = {
    throughput,
    dailyConversation,
  } as unknown as CampaignRateLimiter;

  const getOrCreateConversation = jest.fn().mockResolvedValue({ id: 'conv-1' });
  const recordHumanAgentMessage = jest.fn().mockResolvedValue('message-1');
  const attachOutboundDelivery = jest.fn().mockResolvedValue(undefined);
  const markOutboundFailed = jest.fn().mockResolvedValue(undefined);
  const conversations = {
    getOrCreateConversation,
    recordHumanAgentMessage,
    attachOutboundDelivery,
    markOutboundFailed,
  } as unknown as ConversationService;

  const sendTemplateMessage = opts.sendThrows
    ? jest.fn().mockRejectedValue(opts.sendThrows)
    : jest.fn().mockResolvedValue({ bspMessageId: 'wamid.1' });
  const bspAdapter = { sendTemplateMessage } as unknown as BspAdapter;

  const service = new CampaignSenderService(
    tenantContext,
    limiter,
    conversations,
    bspAdapter,
    { now: () => NOW } as unknown as Clock,
    { warn: jest.fn() } as unknown as AppLoggerService,
  );

  return {
    service,
    writes,
    transactions,
    withTenantTx,
    sendTemplateMessage,
    recordHumanAgentMessage,
    attachOutboundDelivery,
    markOutboundFailed,
    throughput,
    dailyConversation,
  };
}

describe('CampaignSenderService.sendOne — rate limits defer, never drop (D3)', () => {
  it('defers on the throughput limit before anything is claimed', async () => {
    const h = harness({ throughputAllowed: false });

    await expect(
      h.service.sendOne(context(), RECIPIENT),
    ).rejects.toBeInstanceOf(CampaignDeferredError);
    // Nothing claimed means nothing to unwind: the row is still pending.
    expect(h.writes).toHaveLength(0);
    expect(h.sendTemplateMessage).not.toHaveBeenCalled();
  });

  it('defers on the 24h tier limit, carrying the time until the next window', async () => {
    const h = harness({ dailyAllowed: false });

    await expect(h.service.sendOne(context(), RECIPIENT)).rejects.toMatchObject(
      { delayMs: 3_600_000 },
    );
    expect(h.writes).toHaveLength(0);
  });
});

describe('CampaignSenderService.sendOne — consent re-check (D1)', () => {
  it.each([
    ['the global opt-out', { optedOutAt: NOW }],
    ['the marketing opt-out', { marketingOptedOutAt: NOW }],
  ])(
    'skips a customer who set %s between snapshot and send, with a visible reason',
    async (_label, row) => {
      const h = harness({ row });

      await expect(h.service.sendOne(context(), RECIPIENT)).resolves.toBe(
        'skipped_opted_out',
      );
      expect(h.sendTemplateMessage).not.toHaveBeenCalled();
      expect(h.writes[0].values).toMatchObject({
        status: 'skipped',
        skipReason: 'opted_out',
      });
    },
  );

  it('skips an unroutable phone rather than burning a Graph call per row', async () => {
    const h = harness({ row: { phone: '123' } });

    await expect(h.service.sendOne(context(), RECIPIENT)).resolves.toBe(
      'skipped_invalid_phone',
    );
    expect(h.writes[0].values).toMatchObject({
      status: 'skipped',
      skipReason: 'invalid_phone',
    });
  });
});

describe('CampaignSenderService.sendOne — spend cap (D3)', () => {
  it('sends when the next message lands EXACTLY on the cap', async () => {
    const h = harness({
      row: { spentUsd: 1 - UAE_RATE, spendCapUsd: 1 },
    });

    await expect(h.service.sendOne(context(), RECIPIENT)).resolves.toBe('sent');
  });

  it('pauses — with the recipient still pending — when the next message would cross it', async () => {
    const h = harness({
      row: { spentUsd: 1 - UAE_RATE + 0.01, spendCapUsd: 1 },
    });

    await expect(
      h.service.sendOne(context(), RECIPIENT),
    ).rejects.toBeInstanceOf(CampaignPausedError);
    // The cap is checked BEFORE the claim: no write at all, so the row is
    // still `pending` and a resume picks it back up.
    expect(h.writes).toHaveLength(0);
    expect(h.sendTemplateMessage).not.toHaveBeenCalled();
  });

  it('names the spend_cap kind, so the runner knows which paused_* state to use', async () => {
    const h = harness({ row: { spentUsd: 50, spendCapUsd: 50 } });

    await expect(h.service.sendOne(context(), RECIPIENT)).rejects.toMatchObject(
      {
        kind: 'spend_cap',
      },
    );
  });
});

describe('CampaignSenderService.sendOne — the claim (D3)', () => {
  it('claims the row before the Graph call', async () => {
    const h = harness();
    await h.service.sendOne(context(), RECIPIENT);

    const claim = h.writes[0];
    expect(claim.values).toMatchObject({ status: 'sending' });
    // The claim is written in the transaction that PRECEDES the send.
    expect(h.sendTemplateMessage).toHaveBeenCalledTimes(1);
  });

  it('does not send when another worker already holds the row', async () => {
    const h = harness({ claimed: false });

    await expect(h.service.sendOne(context(), RECIPIENT)).resolves.toBe(
      'already_claimed',
    );
    expect(h.sendTemplateMessage).not.toHaveBeenCalled();
  });

  it('does not send for a row that is no longer pending', async () => {
    const h = harness({ row: { status: 'sent' } });

    await expect(h.service.sendOne(context(), RECIPIENT)).resolves.toBe(
      'already_claimed',
    );
    expect(h.sendTemplateMessage).not.toHaveBeenCalled();
  });

  it('does not send for a recipient that does not exist', async () => {
    const h = harness({ row: null });

    await expect(h.service.sendOne(context(), RECIPIENT)).resolves.toBe(
      'already_claimed',
    );
  });
});

describe('CampaignSenderService.sendOne — accounting (D3)', () => {
  it('flips the recipient to sent and increments spent_usd in ONE transaction', async () => {
    const h = harness();
    await h.service.sendOne(context(), RECIPIENT);

    const sentWrite = h.writes.find((write) => write.values.status === 'sent');
    const spendWrite = h.writes.find((write) => 'spentUsd' in write.values);

    expect(sentWrite).toBeDefined();
    expect(spendWrite).toBeDefined();
    // Same transaction index: `spent_usd` is not a counter updated afterwards,
    // it is the thing the guard reads.
    const sentTx = h.transactions[h.writes.indexOf(sentWrite!)];
    const spendTx = h.transactions[h.writes.indexOf(spendWrite!)];
    expect(sentTx).toBe(spendTx);
  });

  it('records the cost that the cap guard priced the message at', async () => {
    const h = harness();
    await h.service.sendOne(context(), RECIPIENT);

    const sentWrite = h.writes.find((write) => write.values.status === 'sent');
    expect(sentWrite!.values.costUsd).toBe(UAE_RATE);
  });

  it('stores the bsp message id, which is how a delivery callback finds this row (D5)', async () => {
    const h = harness();
    await h.service.sendOne(context(), RECIPIENT);

    const sentWrite = h.writes.find((write) => write.values.status === 'sent');
    expect(sentWrite!.values.bspMessageId).toBe('wamid.1');
    expect(h.attachOutboundDelivery).toHaveBeenCalledWith(
      TENANT,
      'message-1',
      'wamid.1',
    );
  });

  it('records the message as human_agent authored by whoever launched the campaign (D6)', async () => {
    const h = harness();
    await h.service.sendOne(context(), RECIPIENT);

    expect(h.recordHumanAgentMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        tenantId: TENANT,
        authorUserId: 'user-1',
        clientMessageId: campaignClientMessageId(CAMPAIGN, RECIPIENT),
      }),
    );
  });

  it('marks a failed send terminal and does NOT bill for it — Meta does not bill an undelivered conversation', async () => {
    const h = harness({ sendThrows: new Error('Graph 131049') });

    await expect(h.service.sendOne(context(), RECIPIENT)).resolves.toBe(
      'failed',
    );
    expect(h.markOutboundFailed).toHaveBeenCalled();
    const failedWrite = h.writes.find(
      (write) => write.values.status === 'failed',
    );
    expect(failedWrite!.values.deliveryError).toMatch(/131049/);
    expect(h.writes.some((write) => 'spentUsd' in write.values)).toBe(false);
  });
});

describe("renderParameters — D2's closed grammar", () => {
  it('passes a literal through unchanged', () => {
    expect(
      renderParameters([{ type: 'literal', value: 'Spring' }], {
        name: 'Sam',
        phone: UAE_PHONE,
      }),
    ).toEqual(['Spring']);
  });

  it('resolves the two whitelisted customer fields', () => {
    expect(
      renderParameters(
        [
          { type: 'customer_field', field: 'name', fallback: 'there' },
          { type: 'customer_field', field: 'phone', fallback: 'unknown' },
        ],
        { name: 'Sam', phone: UAE_PHONE },
      ),
    ).toEqual(['Sam', UAE_PHONE]);
  });

  it.each([null, '', '   '])(
    'falls back for %p rather than sending an empty parameter Meta would reject',
    (name) => {
      expect(
        renderParameters(
          [{ type: 'customer_field', field: 'name', fallback: 'there' }],
          { name: name, phone: UAE_PHONE },
        ),
      ).toEqual(['there']);
    },
  );
});

describe('isSendablePhone', () => {
  it.each([UAE_PHONE, '971501234567', '+12025550123'])(
    'accepts %s',
    (phone) => {
      expect(isSendablePhone(phone)).toBe(true);
    },
  );

  it.each([null, undefined, '', '123', 'abc', '1234567890123456'])(
    'rejects %p',
    (phone) => {
      expect(isSendablePhone(phone)).toBe(false);
    },
  );
});
