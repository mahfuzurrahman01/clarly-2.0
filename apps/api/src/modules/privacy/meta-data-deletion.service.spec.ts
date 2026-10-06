// Gulf T7 (D7): MetaDataDeletionService against an in-memory stand-in for
// the one table it owns. What is asserted is the decision logic — dedupe on
// the signed_request, re-run on failure, idempotent deletion — with the
// social-channel side faked at its service boundary. The real SQL is covered
// by test/integration/meta-privacy.integration-spec.ts.
import type { AppLoggerService } from '../core';
import type {
  AffectedSocialChannel,
  SocialChannelCredentialsService,
} from '../meta-channel/social-channel-credentials.service';
import { hashMetaUserId } from '../meta-graph/meta-user-id-hash';
import type { PersistenceService } from '../persistence/persistence.service';
import {
  DATA_DELETED_REASON,
  MetaDataDeletionService,
} from './meta-data-deletion.service';

interface Row {
  id: string;
  confirmationCode: string;
  metaUserIdHash: string;
  signedRequestHash: string;
  status: string;
  socialChannelsScrubbed: number;
  error: string | null;
  requestedAt: Date;
  completedAt: Date | null;
}

/**
 * Just enough of Drizzle's builder for the four queries the service issues.
 * Values are matched by the column the service filters on, which is why the
 * fake reads the `where` argument's right-hand value off the SQL chunk.
 */
function makeFakeDb() {
  const rows: Row[] = [];
  let nextId = 1;

  const valueOf = (condition: unknown): unknown => {
    const chunks = (condition as { queryChunks: unknown[] }).queryChunks;
    const param = chunks.find(
      (c) =>
        typeof c === 'object' && c !== null && 'value' in c && 'encoder' in c,
    ) as { value: unknown };
    return param.value;
  };

  const db = {
    insert: () => ({
      values: (
        v: Omit<
          Row,
          | 'id'
          | 'requestedAt'
          | 'completedAt'
          | 'error'
          | 'socialChannelsScrubbed'
        >,
      ) => ({
        onConflictDoNothing: () => {
          if (!rows.some((r) => r.signedRequestHash === v.signedRequestHash)) {
            rows.push({
              ...v,
              id: `row-${nextId++}`,
              socialChannelsScrubbed: 0,
              error: null,
              requestedAt: new Date('2026-09-19T10:00:00Z'),
              completedAt: null,
            });
          }
          return Promise.resolve();
        },
      }),
    }),
    select: (fields: Record<string, unknown>) => ({
      from: () => ({
        where: (condition: unknown) => ({
          limit: () => {
            const value = valueOf(condition);
            return Promise.resolve(
              rows
                .filter(
                  (r) =>
                    r.signedRequestHash === value ||
                    r.confirmationCode === value,
                )
                .map((r) =>
                  Object.fromEntries(
                    Object.keys(fields).map((k) => [k, r[k as keyof Row]]),
                  ),
                ),
            );
          },
        }),
      }),
    }),
    update: () => ({
      set: (values: Partial<Row>) => ({
        where: (condition: unknown) => {
          const value = valueOf(condition);
          const row = rows.find((r) => r.id === value);
          if (row) Object.assign(row, values);
          return Promise.resolve();
        },
      }),
    }),
  };

  return { db, rows };
}

function makeHarness(
  scrub: jest.Mock = jest.fn().mockResolvedValue([] as AffectedSocialChannel[]),
) {
  const { db, rows } = makeFakeDb();
  const persistence = {
    runAdminQuery: (fn: (d: unknown) => unknown) => fn(db),
  } as unknown as PersistenceService;
  const logger = {
    log: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
  };
  const service = new MetaDataDeletionService(
    persistence,
    {
      scrubCredentialsForMetaUser: scrub,
    } as unknown as SocialChannelCredentialsService,
    logger as unknown as AppLoggerService,
  );
  return { service, rows, scrub, logger };
}

const USER = { userId: '218471', issuedAt: new Date('2026-09-19T09:59:00Z') };

describe('MetaDataDeletionService.request', () => {
  it("scrubs that user's social-channel credentials and completes with a 32-hex confirmation code", async () => {
    const scrub = jest.fn().mockResolvedValue([
      { tenantId: 't-1', channelAccountId: 'page-1' },
      { tenantId: 't-2', channelAccountId: 'page-2' },
    ]);
    const { service, rows } = makeHarness(scrub);

    const result = await service.request('sig.payload-1', USER);

    expect(scrub).toHaveBeenCalledWith('218471', DATA_DELETED_REASON);
    expect(result.status).toBe('completed');
    expect(result.confirmationCode).toMatch(/^[0-9a-f]{32}$/);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      status: 'completed',
      socialChannelsScrubbed: 2,
      metaUserIdHash: hashMetaUserId('218471'),
    });
    expect(rows[0].completedAt).toBeInstanceOf(Date);
  });

  it('never stores the plaintext Meta user id', async () => {
    const { service, rows } = makeHarness();
    await service.request('sig.payload-1', USER);
    expect(JSON.stringify(rows)).not.toContain('218471');
  });

  it('returns the SAME confirmation code for a re-delivered signed_request, without re-running', async () => {
    const { service, rows, scrub } = makeHarness();

    const first = await service.request('sig.payload-1', USER);
    const second = await service.request('sig.payload-1', USER);

    expect(second.confirmationCode).toBe(first.confirmationCode);
    expect(rows).toHaveLength(1);
    expect(scrub).toHaveBeenCalledTimes(1);
  });

  it('is idempotent for the same user asking twice: a new code, and the second run finds nothing left', async () => {
    const scrub = jest
      .fn()
      .mockResolvedValueOnce([{ tenantId: 't-1', channelAccountId: 'page-1' }])
      .mockResolvedValueOnce([]);
    const { service, rows } = makeHarness(scrub);

    const first = await service.request('sig.payload-1', USER);
    const second = await service.request('sig.payload-2', USER);

    expect(second.confirmationCode).not.toBe(first.confirmationCode);
    expect(second.status).toBe('completed');
    expect(rows.map((r) => r.socialChannelsScrubbed)).toEqual([1, 0]);
  });

  it('marks the request failed (and logs at error) when the deletion throws, then re-runs it on re-delivery', async () => {
    const scrub = jest
      .fn()
      .mockRejectedValueOnce(new Error('db down'))
      .mockResolvedValueOnce([]);
    const { service, rows, logger } = makeHarness(scrub);

    const first = await service.request('sig.payload-1', USER);
    expect(first.status).toBe('failed');
    expect(rows[0]).toMatchObject({ status: 'failed', error: 'db down' });
    expect(logger.error).toHaveBeenCalled();

    const retry = await service.request('sig.payload-1', USER);
    expect(retry).toEqual({
      confirmationCode: first.confirmationCode,
      status: 'completed',
    });
    expect(rows[0]).toMatchObject({ status: 'completed', error: null });
  });
});

describe('MetaDataDeletionService.status', () => {
  it('returns only status and timestamps for a known code', async () => {
    const { service } = makeHarness();
    const { confirmationCode } = await service.request('sig.payload-1', USER);

    const status = await service.status(confirmationCode);

    expect(status).not.toBeNull();
    expect(Object.keys(status ?? {}).sort()).toEqual(
      ['completedAt', 'confirmationCode', 'requestedAt', 'status'].sort(),
    );
    expect(status?.status).toBe('completed');
  });

  it('returns null for an unknown code and for anything not shaped like one, without querying', async () => {
    const { service } = makeHarness();
    expect(await service.status('0'.repeat(32))).toBeNull();
    expect(await service.status("' OR 1=1 --")).toBeNull();
  });
});
