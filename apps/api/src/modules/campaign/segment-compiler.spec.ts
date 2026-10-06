import { PgDialect } from 'drizzle-orm/pg-core';
import {
  UnknownSegmentCriterionError,
  compileSegmentCondition,
} from './segment-compiler';
import {
  REALISED_ORDER_STATUSES,
  type SegmentNode,
} from './segment-definition.schema';
import { ORDER_STATUSES } from '../persistence/drizzle/orders.table';

const dialect = new PgDialect();

function render(node: SegmentNode): { sql: string; params: unknown[] } {
  const fragment = compileSegmentCondition(node);
  const query = dialect.sqlToQuery(fragment);
  return { sql: query.sql, params: query.params };
}

describe('compileSegmentCondition — one test per criterion kind', () => {
  it('label: compiles to an EXISTS over customer_labels with a bound IN list', () => {
    const { sql, params } = render({ kind: 'label', in: ['hot', 'warm'] });
    expect(sql).toContain('EXISTS');
    expect(sql).toContain('"customer_labels"');
    expect(sql).toMatch(/"customer_labels"\."label" in \(/i);
    expect(params).toEqual(['hot', 'warm']);
  });

  it('tag: compiles to a jsonb ?| containment check with bound values', () => {
    const { sql, params } = render({
      kind: 'tag',
      hasAny: ['vip', 'wholesale'],
    });
    expect(sql).toContain('?|');
    expect(sql).toContain('::text[]');
    expect(params).toEqual(['vip', 'wholesale']);
  });

  it('channel: compiles to a bound IN list on customers.channel', () => {
    const { sql, params } = render({ kind: 'channel', in: ['whatsapp'] });
    expect(sql.toLowerCase()).toContain('"customers"."channel" in (');
    expect(params).toEqual(['whatsapp']);
  });

  it('customer_created: compiles to a bound interval comparison', () => {
    const { sql, params } = render({
      kind: 'customer_created',
      within_days: 30,
    });
    expect(sql).toContain('make_interval(days =>');
    expect(sql).toContain('>=');
    expect(params).toEqual([30]);
  });

  it('customer_created_before: compiles to a bound interval comparison', () => {
    const { sql, params } = render({
      kind: 'customer_created_before',
      days_ago: 90,
    });
    expect(sql).toContain('<=');
    expect(params).toEqual([90]);
  });

  it('last_inbound_within_days: compiles to an EXISTS over conversations', () => {
    const { sql, params } = render({
      kind: 'last_inbound_within_days',
      days: 7,
    });
    expect(sql).toContain('EXISTS');
    expect(sql).toContain('"conversations"');
    expect(params).toEqual([7]);
  });

  it('last_inbound_before_days: compiles to an EXISTS (or none-ever) over conversations', () => {
    const { sql, params } = render({
      kind: 'last_inbound_before_days',
      days: 14,
    });
    expect(sql).toContain('"conversations"');
    expect(params).toEqual([14]);
  });

  it.each([
    ['gte' as const, '>='],
    ['lte' as const, '<='],
  ])(
    'order_count (%s): compiles to a correlated count over realised orders only',
    (op, operator) => {
      const { sql, params } = render({ kind: 'order_count', op, value: 3 });
      expect(sql.toLowerCase()).toContain('select count(*) from "orders"');
      expect(sql).toContain(operator);
      // Realised statuses are bound, in order, ahead of the threshold.
      expect(params).toEqual([...REALISED_ORDER_STATUSES, 3]);
    },
  );

  it.each([
    ['gte' as const, '>='],
    ['lte' as const, '<='],
  ])(
    'order_total_usd (%s): sums realised order totals with a COALESCE so a never-ordered customer compares as 0, not NULL',
    (op, operator) => {
      const { sql, params } = render({
        kind: 'order_total_usd',
        op,
        value: 250.5,
      });
      expect(sql.toLowerCase()).toContain('coalesce(sum(');
      expect(sql).toContain('"orders"."total"');
      expect(sql).toContain(operator);
      expect(params).toEqual([...REALISED_ORDER_STATUSES, 250.5]);
    },
  );

  it('last_order_within_days: compiles to an EXISTS over realised orders with a bound interval', () => {
    const { sql, params } = render({
      kind: 'last_order_within_days',
      days: 90,
    });
    expect(sql).toContain('EXISTS');
    expect(sql).toContain('"orders"."created_at"');
    expect(sql).toContain('make_interval(days =>');
    expect(sql).toContain('>=');
    expect(params).toEqual([...REALISED_ORDER_STATUSES, 90]);
  });

  it('never_ordered: compiles to NOT EXISTS over realised orders', () => {
    const { sql, params } = render({ kind: 'never_ordered' });
    expect(sql.toLowerCase()).toContain('not ');
    expect(sql).toContain('EXISTS');
    expect(sql).toContain('"orders"');
    expect(params).toEqual([...REALISED_ORDER_STATUSES]);
  });

  it('a kind with no compiler entry throws UnknownSegmentCriterionError, never silently matching nothing/everything', () => {
    const bogus = { kind: 'bogus' } as unknown as SegmentNode;
    expect(() => compileSegmentCondition(bogus)).toThrow(
      UnknownSegmentCriterionError,
    );
  });
});

describe('compileSegmentCondition — combinators', () => {
  it('and: joins children with AND, bound params in order', () => {
    const { sql, params } = render({
      kind: 'and',
      children: [
        { kind: 'label', in: ['hot'] },
        { kind: 'channel', in: ['whatsapp'] },
      ],
    });
    expect(sql).toMatch(/and/i);
    expect(params).toEqual(['hot', 'whatsapp']);
  });

  it('or: joins children with OR', () => {
    const { sql, params } = render({
      kind: 'or',
      children: [
        { kind: 'label', in: ['hot'] },
        { kind: 'label', in: ['warm'] },
      ],
    });
    expect(sql.toLowerCase()).toContain(' or ');
    expect(params).toEqual(['hot', 'warm']);
  });

  it('not: negates the child', () => {
    const { sql, params } = render({
      kind: 'not',
      child: { kind: 'label', in: ['hot'] },
    });
    expect(sql.toLowerCase()).toContain('not');
    expect(params).toEqual(['hot']);
  });

  it('nested and/or/not compiles without throwing and preserves param order', () => {
    const { params } = render({
      kind: 'and',
      children: [
        { kind: 'label', in: ['hot'] },
        {
          kind: 'or',
          children: [
            { kind: 'tag', hasAny: ['vip'] },
            { kind: 'not', child: { kind: 'channel', in: ['whatsapp'] } },
          ],
        },
      ],
    });
    expect(params).toEqual(['hot', 'vip', 'whatsapp']);
  });
});

describe('compileSegmentCondition — injection attempts land as bound parameters', () => {
  it('label: a malicious string in `in` is a parameter, never concatenated into the SQL text', () => {
    const payload = "hot'); DROP TABLE customers; --";
    const { sql, params } = render({ kind: 'label', in: [payload] });
    expect(sql).not.toContain('DROP TABLE');
    expect(params).toContain(payload);
  });

  it('tag: a malicious string in `hasAny` is a parameter, never concatenated into the SQL text', () => {
    const payload = "vip']::text[]) OR 1=1 --";
    const { sql, params } = render({ kind: 'tag', hasAny: [payload] });
    expect(sql).not.toContain('OR 1=1');
    expect(params).toContain(payload);
  });
});

describe('order-history criteria — only realised orders count (F19 D1)', () => {
  const ORDER_NODES: SegmentNode[] = [
    { kind: 'order_count', op: 'gte', value: 1 },
    { kind: 'order_total_usd', op: 'gte', value: 1 },
    { kind: 'last_order_within_days', days: 30 },
    { kind: 'never_ordered' },
  ];

  it.each(ORDER_NODES)(
    '%j filters orders.status to the realised set and nothing else',
    (node) => {
      const { sql, params } = render(node);
      expect(sql.toLowerCase()).toContain('"orders"."status" in (');
      expect(params.slice(0, REALISED_ORDER_STATUSES.length)).toEqual([
        ...REALISED_ORDER_STATUSES,
      ]);
    },
  );

  it.each([
    'pending_approval',
    'rejected',
    'expired',
    'cancelled',
    'failed',
  ] as const)(
    'never treats %s as a purchase — it is absent from every compiled order criterion',
    (status) => {
      expect(REALISED_ORDER_STATUSES).not.toContain(status);
      for (const node of ORDER_NODES) {
        const { sql, params } = render(node);
        expect(params).not.toContain(status);
        expect(sql).not.toContain(status);
      }
    },
  );

  // The one named constant that couples F19 to F25's vocabulary (D1). If F25
  // renames or drops a status, this fails here rather than silently
  // segmenting on a status that can no longer occur.
  it('every realised status is a real F25 order status', () => {
    for (const status of REALISED_ORDER_STATUSES) {
      expect(ORDER_STATUSES).toContain(status);
    }
  });
});

describe('order-history criteria — tenant scoping is in the SQL itself', () => {
  const ORDER_NODES: SegmentNode[] = [
    { kind: 'order_count', op: 'gte', value: 1 },
    { kind: 'order_total_usd', op: 'lte', value: 100 },
    { kind: 'last_order_within_days', days: 30 },
    { kind: 'never_ordered' },
  ];

  it.each(ORDER_NODES)(
    '%j correlates orders.tenant_id to customers.tenant_id AND orders.customer_id to customers.id',
    (node) => {
      const { sql } = render(node);
      expect(sql).toContain('"orders"."tenant_id" = "customers"."tenant_id"');
      expect(sql).toContain('"orders"."customer_id" = "customers"."id"');
    },
  );

  it.each(ORDER_NODES)(
    '%j never reads orders without a tenant predicate (no bare FROM "orders" scan)',
    (node) => {
      const { sql } = render(node);
      const fromClauses = sql.match(/from "orders"(?! where)/gi) ?? [];
      expect(fromClauses).toHaveLength(0);
    },
  );
});

describe('order-history criteria — boundaries and the empty audience', () => {
  it('order_count gte 0 binds 0, matching every customer including those with no orders', () => {
    const { sql, params } = render({
      kind: 'order_count',
      op: 'gte',
      value: 0,
    });
    expect(params[params.length - 1]).toBe(0);
    expect(sql).toContain('>=');
  });

  it('order_count lte 0 is the count-based spelling of never_ordered: count(*) is 0, not NULL, for a customer with no realised orders', () => {
    const { sql } = render({ kind: 'order_count', op: 'lte', value: 0 });
    expect(sql.toLowerCase()).toContain('count(*)');
    expect(sql.toLowerCase()).not.toContain('coalesce(count');
    expect(sql).toContain('<=');
  });

  it('order_total_usd lte 0 keeps never-ordered customers in the audience via COALESCE', () => {
    const { sql, params } = render({
      kind: 'order_total_usd',
      op: 'lte',
      value: 0,
    });
    expect(sql.toLowerCase()).toContain('coalesce(sum(');
    expect(params[params.length - 1]).toBe(0);
  });

  it('last_order_within_days at the 1-day floor and the 3650-day ceiling binds the day count, not a literal', () => {
    for (const days of [1, 3650]) {
      const { sql, params } = render({ kind: 'last_order_within_days', days });
      expect(params[params.length - 1]).toBe(days);
      // The day count is a bound parameter, never interpolated into the text.
      expect(sql).toMatch(/make_interval\(days => \$\d+\)/);
      expect(sql).not.toContain(`days => ${days}`);
    }
  });

  it('never_ordered is the exact complement of order_count gte 1 over the same realised set', () => {
    const never = render({ kind: 'never_ordered' });
    const everOrdered = render({ kind: 'order_count', op: 'gte', value: 1 });
    expect(never.params).toEqual([...REALISED_ORDER_STATUSES]);
    expect(everOrdered.params).toEqual([...REALISED_ORDER_STATUSES, 1]);
    expect(never.sql.toLowerCase()).toContain('not ');
  });

  it('order criteria compose under and/or/not without a second query pattern (one correlated subquery each, no N+1 hook)', () => {
    const { sql, params } = render({
      kind: 'and',
      children: [
        { kind: 'label', in: ['vip'] },
        { kind: 'not', child: { kind: 'never_ordered' } },
        { kind: 'last_order_within_days', days: 60 },
      ],
    });
    expect(params).toEqual([
      'vip',
      ...REALISED_ORDER_STATUSES,
      ...REALISED_ORDER_STATUSES,
      60,
    ]);
    // Every orders read is a subquery in the WHERE — the compiler emits no
    // join clause the resolver would have to run per customer.
    expect(sql.toLowerCase()).not.toContain('join "orders"');
  });
});
