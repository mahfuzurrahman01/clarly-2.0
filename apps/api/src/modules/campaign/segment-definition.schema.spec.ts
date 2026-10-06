import {
  SEGMENT_CRITERION_KINDS,
  SegmentDefinitionLimitError,
  assertWithinSegmentLimits,
  parseSegmentDefinition,
  segmentDefinitionSchema,
  type SegmentNode,
} from './segment-definition.schema';

function leaf(kind: string): unknown {
  switch (kind) {
    case 'label':
      return { kind, in: ['hot'] };
    case 'tag':
      return { kind, hasAny: ['vip'] };
    case 'channel':
      return { kind, in: ['whatsapp'] };
    case 'customer_created':
      return { kind, within_days: 30 };
    case 'customer_created_before':
      return { kind, days_ago: 30 };
    case 'last_inbound_within_days':
      return { kind, days: 7 };
    case 'last_inbound_before_days':
      return { kind, days: 7 };
    case 'order_count':
      return { kind, op: 'gte', value: 1 };
    case 'order_total_usd':
      return { kind, op: 'gte', value: 100 };
    case 'last_order_within_days':
      return { kind, days: 30 };
    case 'never_ordered':
      return { kind };
    default:
      throw new Error(`no fixture for ${kind}`);
  }
}

describe('segmentDefinitionSchema', () => {
  it.each(SEGMENT_CRITERION_KINDS)(
    'accepts a well-formed %s criterion',
    (kind) => {
      const result = segmentDefinitionSchema.safeParse(leaf(kind));
      expect(result.success).toBe(true);
    },
  );

  it('rejects an unknown kind', () => {
    const result = segmentDefinitionSchema.safeParse({ kind: 'bogus' });
    expect(result.success).toBe(false);
  });

  it('accepts and/or/not combinators, including nested', () => {
    const tree = {
      kind: 'and',
      children: [
        leaf('label'),
        {
          kind: 'or',
          children: [leaf('tag'), { kind: 'not', child: leaf('channel') }],
        },
      ],
    };
    expect(segmentDefinitionSchema.safeParse(tree).success).toBe(true);
  });

  it('rejects an empty children array', () => {
    expect(
      segmentDefinitionSchema.safeParse({ kind: 'and', children: [] }).success,
    ).toBe(false);
  });

  it('rejects more than 20 label values on one criterion', () => {
    const result = segmentDefinitionSchema.safeParse({
      kind: 'label',
      in: Array.from({ length: 21 }, (_, i) => `label-${i}`),
    });
    expect(result.success).toBe(false);
  });
});

describe('assertWithinSegmentLimits', () => {
  it('accepts a tree within depth 3 / 20 leaves', () => {
    const tree: SegmentNode = {
      kind: 'and',
      children: [leaf('label') as SegmentNode, leaf('tag') as SegmentNode],
    };
    expect(() => assertWithinSegmentLimits(tree)).not.toThrow();
  });

  it('rejects more than 20 leaf criteria', () => {
    const tree: SegmentNode = {
      kind: 'or',
      children: Array.from({ length: 10 }, () => ({
        kind: 'and',
        children: [leaf('label') as SegmentNode, leaf('tag') as SegmentNode],
      })),
    };
    // 10 * 2 = 20 leaves is fine; add one more branch to push to 22.
    (tree as { children: SegmentNode[] }).children.push({
      kind: 'and',
      children: [leaf('label') as SegmentNode, leaf('tag') as SegmentNode],
    });
    expect(() => assertWithinSegmentLimits(tree)).toThrow(
      SegmentDefinitionLimitError,
    );
  });

  it('rejects nesting deeper than 3 levels', () => {
    const tree: SegmentNode = {
      kind: 'and',
      children: [
        {
          kind: 'or',
          children: [{ kind: 'not', child: leaf('label') as SegmentNode }],
        },
      ],
    };
    expect(() => assertWithinSegmentLimits(tree)).toThrow(
      SegmentDefinitionLimitError,
    );
  });
});

describe('parseSegmentDefinition', () => {
  it('parses and enforces limits in one call', () => {
    expect(() => parseSegmentDefinition(leaf('label'))).not.toThrow();
  });

  it('throws a Zod error for an invalid shape', () => {
    expect(() => parseSegmentDefinition({ kind: 'bogus' })).toThrow();
  });

  it('throws SegmentDefinitionLimitError for an over-limit tree', () => {
    // 3 groups of 8 leaves each = 24 leaves, within the 10-children-per-node
    // Zod bound but over the 20-leaf structural limit.
    const tree = {
      kind: 'or',
      children: Array.from({ length: 3 }, () => ({
        kind: 'and',
        children: Array.from({ length: 8 }, () => leaf('never_ordered')),
      })),
    };
    expect(() => parseSegmentDefinition(tree)).toThrow(
      SegmentDefinitionLimitError,
    );
  });
});
