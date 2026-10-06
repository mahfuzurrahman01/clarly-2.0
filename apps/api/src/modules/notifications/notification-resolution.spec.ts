import { PgDialect } from 'drizzle-orm/pg-core';
import type { SQL } from 'drizzle-orm';
import { notifications } from '../persistence/drizzle/schema';
import type { DrizzleDb } from '../persistence/persistence.providers';
import { markEntityNotificationsRead } from './notification-resolution';

const dialect = new PgDialect();
const TENANT = '00000000-0000-0000-0000-00000000000a';
const ORDER_ID = '11111111-1111-1111-1111-111111111111';
const NOW = new Date('2026-10-05T10:00:00.000Z');

function fakeTx(returned: unknown[] = [{ id: 'n1' }]) {
  const calls: { table?: unknown; set?: unknown; where?: SQL } = {};
  const tx = {
    update: (table: unknown) => {
      calls.table = table;
      return {
        set: (values: unknown) => {
          calls.set = values;
          return {
            where: (where: SQL) => {
              calls.where = where;
              return { returning: () => Promise.resolve(returned) };
            },
          };
        },
      };
    },
  };
  return { tx: tx as unknown as DrizzleDb, calls };
}

describe('markEntityNotificationsRead', () => {
  it('marks only the unread notifications of the given kinds about the given entities, in the given tenant', async () => {
    const { tx, calls } = fakeTx([{ id: 'n1' }, { id: 'n2' }]);

    const marked = await markEntityNotificationsRead(tx, {
      tenantId: TENANT,
      entityType: 'order',
      entityIds: [ORDER_ID],
      kinds: ['order_pending_approval'],
      readAt: NOW,
    });

    expect(marked).toBe(2);
    expect(calls.table).toBe(notifications);
    expect(calls.set).toEqual({ readAt: NOW });

    const where = dialect.sqlToQuery(calls.where as SQL);
    expect(where.sql).toContain('"notifications"."tenant_id" = $1');
    expect(where.sql).toContain('"notifications"."entity_type" = $2');
    expect(where.sql).toContain('"notifications"."entity_id" in ($3)');
    expect(where.sql).toContain('"notifications"."kind" in ($4)');
    // Already-read rows keep their original read time.
    expect(where.sql).toContain('"notifications"."read_at" is null');
    expect(where.params).toEqual([
      TENANT,
      'order',
      ORDER_ID,
      'order_pending_approval',
    ]);
  });

  it('issues no statement when there is nothing to resolve', async () => {
    const { tx, calls } = fakeTx();

    await expect(
      markEntityNotificationsRead(tx, {
        tenantId: TENANT,
        entityType: 'order',
        entityIds: [],
        kinds: ['order_pending_approval'],
        readAt: NOW,
      }),
    ).resolves.toBe(0);
    expect(calls.table).toBeUndefined();
  });
});
