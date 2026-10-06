// F19 (D1): the segment grammar — a closed set, v1. This is the ONLY shape a
// segment's `definition` may take. Validated on every write AND again on
// every read before compilation (`SegmentCompiler`) — a row hand-edited in
// the DB must not reach the SQL compiler unvalidated.
//
// The four order-history criteria (order_count, order_total_usd,
// last_order_within_days, never_ordered) compile as of 2026-09-22, against
// F25's `orders` table. The grammar itself did not change when `orders`
// landed, as planned. See segment-compiler.ts for the SQL and for why only
// REALISED_ORDER_STATUSES count.
import { z } from 'zod';
import { CHANNELS } from '../channel/ports/channel-kind';

/** F25's realised-purchase states. Named so an F25 vocabulary change is one edit with one failing test, not silent drift (see the schema doc's D1 note). */
export const REALISED_ORDER_STATUSES = ['confirmed', 'fulfilled'] as const;

export const SEGMENT_CRITERION_KINDS = [
  'label',
  'tag',
  'channel',
  'customer_created',
  'customer_created_before',
  'last_inbound_within_days',
  'last_inbound_before_days',
  'order_count',
  'order_total_usd',
  'last_order_within_days',
  'never_ordered',
] as const;
export type SegmentCriterionKind = (typeof SEGMENT_CRITERION_KINDS)[number];

const criterionSchema = z.discriminatedUnion('kind', [
  // F18 labels. Hits customer_labels_tenant_label_idx (tenant_id, label).
  z.object({
    kind: z.literal('label'),
    in: z.array(z.string().max(64)).min(1).max(20),
  }),
  // F5 customer attributes.
  z.object({
    kind: z.literal('tag'),
    hasAny: z.array(z.string().max(64)).min(1).max(20),
  }),
  z.object({
    kind: z.literal('channel'),
    in: z.array(z.enum(CHANNELS)).min(1),
  }),
  z.object({
    kind: z.literal('customer_created'),
    within_days: z.number().int().min(1).max(3650),
  }),
  z.object({
    kind: z.literal('customer_created_before'),
    days_ago: z.number().int().min(1).max(3650),
  }),
  // F4 conversations.
  z.object({
    kind: z.literal('last_inbound_within_days'),
    days: z.number().int().min(1).max(365),
  }),
  z.object({
    kind: z.literal('last_inbound_before_days'),
    days: z.number().int().min(1).max(365),
  }),
  // F25 order history. All four count ONLY orders in a realised state
  // (REALISED_ORDER_STATUSES) — see segment-compiler.ts.
  z.object({
    kind: z.literal('order_count'),
    op: z.enum(['gte', 'lte']),
    value: z.number().int().min(0).max(100000),
  }),
  z.object({
    kind: z.literal('order_total_usd'),
    op: z.enum(['gte', 'lte']),
    value: z.number().min(0).max(1e9),
  }),
  z.object({
    kind: z.literal('last_order_within_days'),
    days: z.number().int().min(1).max(3650),
  }),
  z.object({ kind: z.literal('never_ordered') }),
]);

export type SegmentCriterion = z.infer<typeof criterionSchema>;

export type SegmentNode =
  | SegmentCriterion
  | { kind: 'and'; children: SegmentNode[] }
  | { kind: 'or'; children: SegmentNode[] }
  | { kind: 'not'; child: SegmentNode };

export const nodeSchema: z.ZodType<SegmentNode> = z.lazy(() =>
  z.union([
    criterionSchema,
    z.object({
      kind: z.literal('and'),
      children: z.array(nodeSchema).min(1).max(10),
    }),
    z.object({
      kind: z.literal('or'),
      children: z.array(nodeSchema).min(1).max(10),
    }),
    z.object({ kind: z.literal('not'), child: nodeSchema }),
  ]),
);

export const segmentDefinitionSchema = nodeSchema;

/** Hard structural limits Zod's recursion alone does not bound — a post-parse walk. */
export const SEGMENT_MAX_DEPTH = 3;
export const SEGMENT_MAX_LEAVES = 20;

export class SegmentDefinitionLimitError extends Error {
  constructor(
    message: string,
    public readonly limit: 'depth' | 'leaves',
    public readonly max: number,
    public readonly actual: number,
  ) {
    super(message);
    this.name = 'SegmentDefinitionLimitError';
  }
}

/**
 * Walks a (Zod-valid) tree and enforces `SEGMENT_MAX_DEPTH` and
 * `SEGMENT_MAX_LEAVES`. Zod's `.min()/.max()` on `children` bounds branching
 * factor per node but not total depth or total leaf count across the whole
 * tree — this is that missing bound. Callers translate this into a 422
 * naming the limit, per D1.
 */
export function assertWithinSegmentLimits(node: SegmentNode): void {
  const leafCount = countLeaves(node, 1);
  if (leafCount > SEGMENT_MAX_LEAVES) {
    throw new SegmentDefinitionLimitError(
      `Segment definition has ${leafCount} leaf criteria; the maximum is ${SEGMENT_MAX_LEAVES}.`,
      'leaves',
      SEGMENT_MAX_LEAVES,
      leafCount,
    );
  }
}

function countLeaves(node: SegmentNode, depth: number): number {
  if (depth > SEGMENT_MAX_DEPTH) {
    throw new SegmentDefinitionLimitError(
      `Segment definition nests ${depth} levels deep; the maximum is ${SEGMENT_MAX_DEPTH}.`,
      'depth',
      SEGMENT_MAX_DEPTH,
      depth,
    );
  }
  if (node.kind === 'and' || node.kind === 'or') {
    return node.children.reduce(
      (sum, child) => sum + countLeaves(child, depth + 1),
      0,
    );
  }
  if (node.kind === 'not') {
    return countLeaves(node.child, depth + 1);
  }
  return 1;
}

/** Parses and structurally validates in one call — the shape every write and every pre-compile read should use. */
export function parseSegmentDefinition(value: unknown): SegmentNode {
  const node = segmentDefinitionSchema.parse(value);
  assertWithinSegmentLimits(node);
  return node;
}
