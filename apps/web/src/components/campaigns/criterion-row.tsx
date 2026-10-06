"use client";

import { useState } from "react";
import { Info, X } from "lucide-react";
import {
  CHANNEL_KINDS,
  MAX_CRITERION_LIST_VALUES,
  MAX_CRITERION_VALUE_LENGTH,
  SEGMENT_CRITERIA,
  criterionSpec,
  type ChannelKind,
  type SegmentCriterion,
  type SegmentCriterionKind,
} from "@/lib/api/campaigns";
import { useTranslations } from "@/lib/i18n/provider";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { cn } from "@/lib/utils";
import { defaultCriterion, type FlatRule } from "./segment-definition";

export function useCriterionLabels(): Record<SegmentCriterionKind, string> {
  const t = useTranslations();
  return {
    label: t.campaigns.criteria.label,
    tag: t.campaigns.criteria.tag,
    channel: t.campaigns.criteria.channel,
    customer_created: t.campaigns.criteria.customerCreated,
    customer_created_before: t.campaigns.criteria.customerCreatedBefore,
    last_inbound_within_days: t.campaigns.criteria.lastInboundWithinDays,
    last_inbound_before_days: t.campaigns.criteria.lastInboundBeforeDays,
    order_count: t.campaigns.criteria.orderCount,
    order_total_usd: t.campaigns.criteria.orderTotalUsd,
    last_order_within_days: t.campaigns.criteria.lastOrderWithinDays,
    never_ordered: t.campaigns.criteria.neverOrdered,
  };
}

const ORDER_KINDS: readonly SegmentCriterionKind[] = [
  "order_count",
  "order_total_usd",
  "last_order_within_days",
  "never_ordered",
];

/**
 * What an operator would otherwise get wrong about a rule.
 *
 *  - The order criteria count only *realised* orders (F25's `confirmed` and
 *    `fulfilled`). A customer whose single order is still awaiting approval
 *    counts as never having ordered — the opposite of what everyone assumes.
 *  - `order_total_usd` is a misnomer frozen into the v1 grammar: totals are
 *    summed in the tenant's own stored currency with no FX anywhere in the
 *    path, so the UI never writes "USD" or "$" next to it.
 *  - `... at most 0` matches never-ordered customers too, so it overlaps
 *    with the dedicated rule rather than complementing it.
 */
function criterionNotes(
  rule: FlatRule,
  t: ReturnType<typeof useTranslations>,
): string[] {
  const notes: string[] = [];
  const spec = criterionSpec(rule.criterion.kind);
  if (!spec.supported) notes.push(t.campaigns.criteria.notAvailableBody);
  if (ORDER_KINDS.includes(rule.criterion.kind)) {
    notes.push(t.campaigns.criteria.orderStatesNote);
  }
  if (rule.criterion.kind === "order_total_usd") {
    notes.push(t.campaigns.criteria.orderCurrencyNote);
  }
  if (
    (rule.criterion.kind === "order_count" ||
      rule.criterion.kind === "order_total_usd") &&
    rule.criterion.op === "lte" &&
    rule.criterion.value === 0
  ) {
    notes.push(t.campaigns.criteria.orderZeroNote);
  }
  return notes;
}

/**
 * One rule of an audience.
 *
 * Criteria the server cannot compile yet are listed and DISABLED with a "not
 * available yet" note rather than hidden — a merchant can see what is
 * coming, and turning one on is a single `supported: true` in
 * `SEGMENT_CRITERIA`, not a rewrite here. Nothing in this component branches
 * on a specific kind; it branches on the kind's declared input shape.
 */
export function CriterionRow({
  rule,
  index,
  onChange,
  onRemove,
}: {
  rule: FlatRule;
  index: number;
  onChange: (rule: FlatRule) => void;
  onRemove: () => void;
}) {
  const t = useTranslations();
  const labels = useCriterionLabels();
  const kindId = `criterion-kind-${index}`;
  const notes = criterionNotes(rule, t);

  return (
    <div className="grid gap-3 rounded-lg border border-border bg-card p-3 md:grid-cols-[minmax(0,16rem)_minmax(0,1fr)_auto] md:items-center">
      <div className="space-y-1.5">
        <label htmlFor={kindId} className="sr-only">
          {t.campaigns.criteria.pickRule}
        </label>
        <Select
          value={rule.criterion.kind}
          onValueChange={(next) =>
            onChange({
              ...rule,
              criterion: defaultCriterion(next as SegmentCriterionKind),
            })
          }
        >
          <SelectTrigger id={kindId} className="w-full">
            <SelectValue>{() => labels[rule.criterion.kind]}</SelectValue>
          </SelectTrigger>
          <SelectContent>
            {SEGMENT_CRITERIA.map((entry) => (
              <SelectItem
                key={entry.kind}
                value={entry.kind}
                disabled={!entry.supported}
              >
                {labels[entry.kind]}
                {entry.supported ? null : (
                  <span className="ms-2 text-xs text-muted-foreground">
                    {t.campaigns.criteria.notAvailable}
                  </span>
                )}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>

      <CriterionOperand
        criterion={rule.criterion}
        index={index}
        onChange={(criterion) => onChange({ ...rule, criterion })}
      />

      <div className="flex items-center justify-end gap-1">
        <Button
          type="button"
          variant={rule.negated ? "secondary" : "ghost"}
          size="sm"
          aria-pressed={rule.negated}
          onClick={() => onChange({ ...rule, negated: !rule.negated })}
        >
          {rule.negated
            ? t.campaigns.segment.negated
            : t.campaigns.segment.negate}
        </Button>
        <Button
          type="button"
          variant="ghost"
          size="icon-sm"
          onClick={onRemove}
          aria-label={t.campaigns.segment.removeRule}
        >
          <X />
        </Button>
      </div>

      {notes.length > 0 ? (
        <div className="space-y-1.5 md:col-span-3">
          {notes.map((note) => (
            <p
              key={note}
              className="flex items-start gap-2 rounded-lg bg-secondary px-3 py-2 text-xs leading-relaxed text-muted-foreground"
            >
              <Info className="mt-0.5 size-3.5 shrink-0" aria-hidden />
              {note}
            </p>
          ))}
        </div>
      ) : null}
    </div>
  );
}

function CriterionOperand({
  criterion,
  index,
  onChange,
}: {
  criterion: SegmentCriterion;
  index: number;
  onChange: (criterion: SegmentCriterion) => void;
}) {
  const t = useTranslations();
  const spec = criterionSpec(criterion.kind);

  if (spec.input.form === "none") {
    return <span className="text-sm text-muted-foreground">—</span>;
  }

  if (spec.input.form === "strings") {
    const values = criterion.kind === "label" ? criterion.in : criterion.kind === "tag" ? criterion.hasAny : [];
    return (
      <ChipsInput
        values={values}
        inputId={`criterion-values-${index}`}
        onChange={(next) =>
          onChange(
            criterion.kind === "label"
              ? { kind: "label", in: next }
              : { kind: "tag", hasAny: next },
          )
        }
      />
    );
  }

  if (spec.input.form === "channels") {
    const selected = criterion.kind === "channel" ? criterion.in : [];
    const CHANNEL_LABEL: Record<ChannelKind, string> = {
      whatsapp: t.campaigns.criteria.channelWhatsapp,
      messenger: t.campaigns.criteria.channelMessenger,
      instagram: t.campaigns.criteria.channelInstagram,
    };
    return (
      <div className="flex flex-wrap gap-1.5">
        {CHANNEL_KINDS.map((channel) => {
          const active = selected.includes(channel);
          return (
            <Button
              key={channel}
              type="button"
              size="sm"
              variant={active ? "secondary" : "outline"}
              aria-pressed={active}
              onClick={() => {
                // Never let the last channel be removed: `in` has min(1).
                const next = active
                  ? selected.filter((item) => item !== channel)
                  : [...selected, channel];
                onChange({
                  kind: "channel",
                  in: next.length > 0 ? next : [channel],
                });
              }}
            >
              {CHANNEL_LABEL[channel]}
            </Button>
          );
        })}
      </div>
    );
  }

  if (spec.input.form === "days") {
    const days =
      criterion.kind === "customer_created"
        ? criterion.within_days
        : criterion.kind === "customer_created_before"
          ? criterion.days_ago
          : criterion.kind === "last_inbound_within_days" ||
              criterion.kind === "last_inbound_before_days" ||
              criterion.kind === "last_order_within_days"
            ? criterion.days
            : 0;
    return (
      <div className="flex items-center gap-2">
        <Input
          type="number"
          inputMode="numeric"
          className="w-28 tabular-nums"
          min={spec.input.min}
          max={spec.input.max}
          value={days}
          aria-label={t.campaigns.criteria.daysSuffix}
          onChange={(event) => {
            const value = clamp(
              Number(event.target.value),
              spec.input.form === "days" ? spec.input.min : 1,
              spec.input.form === "days" ? spec.input.max : 3650,
            );
            switch (criterion.kind) {
              case "customer_created":
                onChange({ kind: "customer_created", within_days: value });
                break;
              case "customer_created_before":
                onChange({ kind: "customer_created_before", days_ago: value });
                break;
              case "last_inbound_within_days":
              case "last_inbound_before_days":
              case "last_order_within_days":
                onChange({ kind: criterion.kind, days: value });
                break;
              default:
                break;
            }
          }}
        />
        <span className="text-sm text-muted-foreground">
          {criterion.kind === "customer_created_before"
            ? t.campaigns.criteria.daysAgoSuffix
            : t.campaigns.criteria.daysSuffix}
        </span>
      </div>
    );
  }

  // amount — an operator plus a number.
  const op = criterion.kind === "order_count" || criterion.kind === "order_total_usd" ? criterion.op : "gte";
  const value =
    criterion.kind === "order_count" || criterion.kind === "order_total_usd"
      ? criterion.value
      : 0;
  const OP_LABEL: Record<"gte" | "lte", string> = {
    gte: t.campaigns.criteria.opGte,
    lte: t.campaigns.criteria.opLte,
  };

  return (
    <div className="flex items-center gap-2">
      <Select
        value={op}
        onValueChange={(next) => {
          if (criterion.kind !== "order_count" && criterion.kind !== "order_total_usd") return;
          onChange({ ...criterion, op: next as "gte" | "lte" });
        }}
      >
        <SelectTrigger className="w-32" aria-label={OP_LABEL[op]}>
          <SelectValue>{() => OP_LABEL[op]}</SelectValue>
        </SelectTrigger>
        <SelectContent>
          <SelectItem value="gte">{OP_LABEL.gte}</SelectItem>
          <SelectItem value="lte">{OP_LABEL.lte}</SelectItem>
        </SelectContent>
      </Select>
      <Input
        type="number"
        inputMode="decimal"
        className="w-32 tabular-nums"
        min={spec.input.form === "amount" ? spec.input.min : 0}
        max={spec.input.form === "amount" ? spec.input.max : undefined}
        step={spec.input.form === "amount" && spec.input.integer ? 1 : "any"}
        value={value}
        onChange={(event) => {
          if (criterion.kind !== "order_count" && criterion.kind !== "order_total_usd") return;
          const raw = Number(event.target.value);
          const bounds = spec.input.form === "amount" ? spec.input : null;
          const next = bounds
            ? clamp(bounds.integer ? Math.round(raw) : raw, bounds.min, bounds.max)
            : raw;
          onChange({ ...criterion, value: next });
        }}
      />
    </div>
  );
}

function clamp(value: number, min: number, max: number): number {
  if (!Number.isFinite(value)) return min;
  return Math.min(Math.max(value, min), max);
}

/** Free-text values (labels, tags) as chips — Enter or comma commits one. */
function ChipsInput({
  values,
  inputId,
  onChange,
}: {
  values: string[];
  inputId: string;
  onChange: (values: string[]) => void;
}) {
  const t = useTranslations();
  const [draft, setDraft] = useState("");

  function commit(raw: string) {
    const value = raw.trim().slice(0, MAX_CRITERION_VALUE_LENGTH);
    if (!value || values.includes(value)) {
      setDraft("");
      return;
    }
    if (values.length >= MAX_CRITERION_LIST_VALUES) return;
    onChange([...values, value]);
    setDraft("");
  }

  return (
    <div className="space-y-1.5">
      <div className={cn("flex flex-wrap items-center gap-1.5", values.length === 0 && "hidden")}>
        {values.map((value) => (
          <span
            key={value}
            className="inline-flex items-center gap-1 rounded-full border border-border bg-secondary px-2 py-0.5 text-xs text-foreground"
          >
            {value}
            <button
              type="button"
              onClick={() => onChange(values.filter((item) => item !== value))}
              className="rounded-full text-muted-foreground transition-colors hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring/50 focus-visible:outline-none"
              aria-label={`${t.campaigns.segment.removeRule}: ${value}`}
            >
              <X className="size-3" aria-hidden />
            </button>
          </span>
        ))}
      </div>
      <Input
        id={inputId}
        value={draft}
        placeholder={t.campaigns.criteria.valuesPlaceholder}
        maxLength={MAX_CRITERION_VALUE_LENGTH}
        onChange={(event) => {
          const next = event.target.value;
          if (next.endsWith(",")) commit(next.slice(0, -1));
          else setDraft(next);
        }}
        onKeyDown={(event) => {
          if (event.key === "Enter") {
            event.preventDefault();
            commit(draft);
          }
        }}
        onBlur={() => commit(draft)}
      />
      {values.length === 0 ? (
        <p className="text-xs text-muted-foreground">
          {t.campaigns.criteria.valuesEmpty}
        </p>
      ) : null}
    </div>
  );
}
