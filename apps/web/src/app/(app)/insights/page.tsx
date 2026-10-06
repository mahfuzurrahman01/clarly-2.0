import { getConsoleSession } from "@/lib/session";
import { getLocale } from "@/lib/i18n/locale";
import { getDictionary } from "@/lib/i18n/get-dictionary";
import {
  getEscalationBreakdown,
  getKnowledgeGapReport,
  getResolutionRate,
  type EscalationBreakdown,
  type KnowledgeGapReport,
  type ResolutionRate,
} from "@/lib/api/metrics";
import { PageHeader } from "@/components/shell/page-header";
import { InsightsView } from "@/components/insights/insights-view";

export const dynamic = "force-dynamic";

function isoDate(d: Date): string {
  return d.toISOString().slice(0, 10);
}

function ok<T>(r: PromiseSettledResult<T>): T | null {
  return r.status === "fulfilled" ? r.value : null;
}

export default async function InsightsPage({
  searchParams,
}: {
  searchParams: Promise<{ from?: string; to?: string }>;
}) {
  const t = getDictionary(await getLocale());
  const session = await getConsoleSession();

  if (session.role !== "admin") {
    return (
      <div className="mx-auto w-full max-w-6xl px-6 py-10 xl:px-10">
        <PageHeader eyebrow={t.insights.eyebrow} title={t.insights.title} />
        <div className="mt-8 rounded-xl border border-border p-8">
          <p className="text-sm text-muted-foreground">{t.insights.adminOnly}</p>
        </div>
      </div>
    );
  }

  const params = await searchParams;
  const defaultTo = new Date();
  const defaultFrom = new Date(defaultTo.getTime() - 30 * 86_400_000);
  const from = params.from ?? isoDate(defaultFrom);
  const to = params.to ?? isoDate(defaultTo);

  const [rateR, breakdownR, gapsR] = await Promise.allSettled([
    getResolutionRate(from, to, session.token),
    getEscalationBreakdown(from, to, session.token),
    getKnowledgeGapReport(from, to, 50, session.token),
  ]);

  const rate = ok<ResolutionRate>(rateR);
  const breakdown = ok<EscalationBreakdown>(breakdownR);
  const gaps = ok<KnowledgeGapReport>(gapsR);

  return (
    <div className="mx-auto w-full max-w-6xl px-6 py-10 xl:px-10">
      <PageHeader
        eyebrow={t.insights.eyebrow}
        title={t.insights.title}
        description={t.insights.description}
      />
      <div className="mt-8">
        <InsightsView from={from} to={to} rate={rate} breakdown={breakdown} gaps={gaps} />
      </div>
    </div>
  );
}
