import type {
  SegmentCriterion,
  SegmentCriterionKind,
  SegmentNode,
} from "@/lib/api/campaigns";

/**
 * The console's editing model for a segment definition.
 *
 * The grammar (D1) is a recursive and/or/not tree up to depth 3. The editor
 * offers the shape merchants actually build — "match ALL / ANY of these
 * rules, each optionally inverted" — which is exactly one level of and/or
 * over criteria and `not(criterion)` leaves.
 *
 * A definition that does not fit that shape (hand-built through the API with
 * nested groups) is not mangled: `flattenDefinition` returns null and the UI
 * shows the segment read-only with an explanation, rather than silently
 * rewriting somebody's audience.
 */

export type FlatRule = { criterion: SegmentCriterion; negated: boolean };

export type FlatDefinition = {
  match: "and" | "or";
  rules: FlatRule[];
};

function isCriterion(node: SegmentNode): node is SegmentCriterion {
  return node.kind !== "and" && node.kind !== "or" && node.kind !== "not";
}

function asRule(node: SegmentNode): FlatRule | null {
  if (isCriterion(node)) return { criterion: node, negated: false };
  if (node.kind === "not" && isCriterion(node.child)) {
    return { criterion: node.child, negated: true };
  }
  return null;
}

/** Null when the definition uses nesting the simple editor cannot represent. */
export function flattenDefinition(node: SegmentNode): FlatDefinition | null {
  if (node.kind === "and" || node.kind === "or") {
    const rules: FlatRule[] = [];
    for (const child of node.children) {
      const rule = asRule(child);
      if (!rule) return null;
      rules.push(rule);
    }
    return { match: node.kind, rules };
  }
  const single = asRule(node);
  return single ? { match: "and", rules: [single] } : null;
}

export function expandDefinition(flat: FlatDefinition): SegmentNode {
  return {
    kind: flat.match,
    children: flat.rules.map((rule) =>
      rule.negated
        ? ({ kind: "not", child: rule.criterion } as SegmentNode)
        : rule.criterion,
    ),
  };
}

/** A new rule's starting value: valid on its own, so an untouched rule still saves. */
export function defaultCriterion(kind: SegmentCriterionKind): SegmentCriterion {
  switch (kind) {
    case "label":
      return { kind: "label", in: [] };
    case "tag":
      return { kind: "tag", hasAny: [] };
    case "channel":
      return { kind: "channel", in: ["whatsapp"] };
    case "customer_created":
      return { kind: "customer_created", within_days: 30 };
    case "customer_created_before":
      return { kind: "customer_created_before", days_ago: 30 };
    case "last_inbound_within_days":
      return { kind: "last_inbound_within_days", days: 30 };
    case "last_inbound_before_days":
      return { kind: "last_inbound_before_days", days: 60 };
    case "order_count":
      return { kind: "order_count", op: "gte", value: 1 };
    case "order_total_usd":
      return { kind: "order_total_usd", op: "gte", value: 100 };
    case "last_order_within_days":
      return { kind: "last_order_within_days", days: 90 };
    case "never_ordered":
      return { kind: "never_ordered" };
  }
}

/** A rule with an empty value list would be rejected by the API's `min(1)`; caught before the round trip. */
export function criterionValues(criterion: SegmentCriterion): string[] | null {
  if (criterion.kind === "label") return criterion.in;
  if (criterion.kind === "tag") return criterion.hasAny;
  if (criterion.kind === "channel") return criterion.in;
  return null;
}

export function isCriterionComplete(criterion: SegmentCriterion): boolean {
  const values = criterionValues(criterion);
  return values === null || values.length > 0;
}
