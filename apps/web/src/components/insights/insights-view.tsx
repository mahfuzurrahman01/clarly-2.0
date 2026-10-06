"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { HelpCircle, Loader2, MessageCircleQuestion } from "lucide-react";
import type {
  EscalationBreakdown,
  KnowledgeGapReport,
  ResolutionRate,
} from "@/lib/api/metrics";
import { escalationLabel } from "@/lib/tickets/escalation";
import { useLocale, useTranslations } from "@/lib/i18n/provider";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";

function StatTile({
  label,
  value,
  hint,
  accent,
}: {
  label: string;
  value: string;
  hint: string;
  accent?: boolean;
}) {
  return (
    <div className="rounded-xl border border-border bg-card/60 p-5 backdrop-blur-md">
      <p className="eyebrow text-muted-foreground">{label}</p>
      <p
        className={
          accent
            ? "mt-2 font-display text-4xl font-medium tracking-tight text-lime-text"
            : "mt-2 font-display text-4xl font-medium tracking-tight"
        }
      >
        {value}
      </p>
      <p className="mt-1 text-xs text-muted-foreground">{hint}</p>
    </div>
  );
}

function BreakdownBars({ breakdown }: { breakdown: EscalationBreakdown }) {
  const t = useTranslations();
  const locale = useLocale();
  const entries = Object.entries(breakdown)
    .map(([reason, count]) => ({ reason, count: count ?? 0 }))
    .filter((e) => e.count > 0)
    .sort((a, b) => b.count - a.count);

  if (entries.length === 0) {
    return <p className="text-sm text-muted-foreground">{t.insights.noEscalations}</p>;
  }

  const max = Math.max(...entries.map((e) => e.count));

  return (
    <div className="space-y-2.5">
      {entries.map(({ reason, count }) => (
        <div key={reason} className="flex items-center gap-3">
          <span className="w-32 shrink-0 text-sm leading-snug text-muted-foreground [overflow-wrap:anywhere] sm:w-48">
            {escalationLabel(reason, locale)}
          </span>
          <div className="h-2 flex-1 overflow-hidden rounded-full bg-secondary">
            <div
              className="h-full rounded-full bg-lime"
              style={{ width: `${Math.max(6, (count / max) * 100)}%` }}
            />
          </div>
          <span className="w-8 shrink-0 text-end text-sm tabular-nums">{count}</span>
        </div>
      ))}
    </div>
  );
}

function KnowledgeGapsTable({ report }: { report: KnowledgeGapReport }) {
  const t = useTranslations();
  const locale = useLocale();

  if (report.gaps.length === 0) {
    return <p className="text-sm text-muted-foreground">{t.insights.noGaps}</p>;
  }

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap gap-2">
        {report.totals.map(({ reason, count }) => (
          <span
            key={reason}
            className="inline-flex items-center gap-1.5 rounded-full border border-border bg-secondary px-3 py-1 text-xs text-muted-foreground"
          >
            {escalationLabel(reason, locale)}
            <span className="font-medium text-foreground">{count}</span>
          </span>
        ))}
      </div>
      <div className="relative overflow-x-auto rounded-xl border border-border">
        <table className="w-full text-sm">
          <thead className="bg-secondary/60 text-xs text-muted-foreground">
            <tr>
              <th className="px-4 py-2 text-start font-medium">{t.insights.colTime}</th>
              <th className="px-4 py-2 text-start font-medium">{t.insights.colReason}</th>
              <th className="px-4 py-2 text-start font-medium">{t.insights.colQuestion}</th>
            </tr>
          </thead>
          <tbody>
            {report.gaps.map((gap, i) => (
              <tr key={`${gap.conversationId}-${i}`} className="border-t border-border align-top">
                <td className="whitespace-nowrap px-4 py-3 text-xs text-muted-foreground">
                  {new Date(gap.occurredAt).toLocaleString()}
                </td>
                <td className="px-4 py-3 text-xs">
                  {escalationLabel(gap.reason, locale)}
                </td>
                <td className="px-4 py-3 text-sm">
                  {gap.question !== null ? (
                    <bdi>{gap.question}</bdi>
                  ) : (
                    <span className="italic text-muted-foreground">
                      {t.insights.transcriptPurged}
                    </span>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

export function InsightsView({
  from,
  to,
  rate,
  breakdown,
  gaps,
}: {
  from: string;
  to: string;
  rate: ResolutionRate | null;
  breakdown: EscalationBreakdown | null;
  gaps: KnowledgeGapReport | null;
}) {
  const t = useTranslations();
  const router = useRouter();
  const [fromInput, setFromInput] = useState(from);
  const [toInput, setToInput] = useState(to);
  const [applying, setApplying] = useState(false);

  function applyRange(e: React.FormEvent) {
    e.preventDefault();
    if (!fromInput || !toInput) return;
    setApplying(true);
    router.push(`/insights?from=${fromInput}&to=${toInput}`);
  }

  return (
    <div className="space-y-10">
      <form onSubmit={applyRange} className="flex flex-wrap items-end gap-3">
        <div className="space-y-2">
          <label className="text-sm font-medium" htmlFor="range-from">
            {t.insights.fromLabel}
          </label>
          <Input
            id="range-from"
            type="date"
            value={fromInput}
            max={toInput}
            onChange={(e) => setFromInput(e.target.value)}
          />
        </div>
        <div className="space-y-2">
          <label className="text-sm font-medium" htmlFor="range-to">
            {t.insights.toLabel}
          </label>
          <Input
            id="range-to"
            type="date"
            value={toInput}
            min={fromInput}
            onChange={(e) => setToInput(e.target.value)}
          />
        </div>
        <Button type="submit" variant="outline" disabled={applying}>
          {applying ? <Loader2 className="size-4 animate-spin" /> : null}
          {t.insights.applyRange}
        </Button>
      </form>

      {rate ? (
        <section>
          <p className="eyebrow text-lime-text">{t.insights.resolutionSection}</p>
          <div className="mt-3 grid gap-4 sm:grid-cols-3">
            <StatTile
              label={t.insights.resolved}
              value={`${Math.round(rate.resolutionRate * 100)}%`}
              hint={`${rate.resolvedConversations} / ${rate.totalConversations}`}
              accent
            />
            <StatTile
              label={t.insights.conversations}
              value={rate.totalConversations.toLocaleString()}
              hint={t.insights.inRange}
            />
            <StatTile
              label={t.insights.escalations}
              value={rate.totalConversations > 0 ? String(rate.totalConversations - rate.resolvedConversations) : "0"}
              hint={t.insights.handedToHuman}
            />
          </div>
        </section>
      ) : (
        <p className="text-sm text-muted-foreground">{t.insights.couldNotLoadRate}</p>
      )}

      <section>
        <p className="eyebrow text-muted-foreground">{t.insights.escalationSection}</p>
        <div className="mt-3 rounded-xl border border-border bg-card/60 p-5 backdrop-blur-md">
          {breakdown ? (
            <BreakdownBars breakdown={breakdown} />
          ) : (
            <p className="text-sm text-muted-foreground">{t.insights.couldNotLoadBreakdown}</p>
          )}
        </div>
      </section>

      <section>
        <div className="flex items-center gap-2">
          <MessageCircleQuestion className="size-4 text-muted-foreground" />
          <p className="eyebrow text-muted-foreground">{t.insights.gapsSection}</p>
          <span title={t.insights.gapsHint}>
            <HelpCircle className="size-3.5 text-muted-foreground/60" />
          </span>
        </div>
        <div className="mt-3">
          {gaps ? (
            <KnowledgeGapsTable report={gaps} />
          ) : (
            <p className="text-sm text-muted-foreground">{t.insights.couldNotLoadGaps}</p>
          )}
        </div>
      </section>
    </div>
  );
}
