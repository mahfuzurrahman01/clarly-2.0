import Link from "next/link";
import {
  ArrowRight,
  Inbox as InboxIcon,
  LayoutList,
  Sparkles,
} from "lucide-react";
import { getConsoleSession } from "@/lib/session";
import { getLocale } from "@/lib/i18n/locale";
import { getDictionary } from "@/lib/i18n/get-dictionary";
import { listTickets } from "@/lib/api/kanban";
import { listConversations } from "@/lib/api/inbox";
import {
  getEscalationBreakdown,
  getResolutionRate,
  type EscalationBreakdown,
  type ResolutionRate,
} from "@/lib/api/metrics";
import { escalationLabel } from "@/lib/tickets/escalation";
import { PageHeader } from "@/components/shell/page-header";
import { Card, CardContent } from "@/components/ui/card";

export const dynamic = "force-dynamic";

/** Unwrap an allSettled result, swallowing failures (403, empty body, etc.). */
function ok<T>(r: PromiseSettledResult<T>): T | null {
  return r.status === "fulfilled" ? r.value : null;
}

function isoDate(d: Date): string {
  return d.toISOString().slice(0, 10);
}

export default async function HomePage() {
  const locale = await getLocale();
  const t = getDictionary(locale);
  const session = await getConsoleSession();
  const { token, role } = session;
  const isAdmin = role === "admin";

  const to = new Date();
  const from = new Date(to.getTime() - 30 * 86_400_000);
  const [fromIso, toIso] = [isoDate(from), isoDate(to)];

  // Everything is best-effort: one endpoint 403-ing (agent role) or returning an
  // empty body must not blank the whole page.
  const [ticketsR, convosR, rateR, breakdownR] = await Promise.allSettled([
    listTickets("all", token),
    listConversations({ limit: 50 }, token),
    isAdmin
      ? getResolutionRate(fromIso, toIso, token)
      : Promise.reject<ResolutionRate>(new Error("skip")),
    isAdmin
      ? getEscalationBreakdown(fromIso, toIso, token)
      : Promise.reject<EscalationBreakdown>(new Error("skip")),
  ]);

  const tickets = ok(ticketsR) ?? [];
  const convos = ok(convosR);
  const rate = ok(rateR);
  const breakdown = ok(breakdownR);

  const openTickets = tickets.filter((t) => t.status === "OPEN").length;
  const liveConvos = convos?.items.length ?? 0;
  const liveMore = convos?.nextCursor ? "+" : "";

  return (
    <div className="mx-auto w-full max-w-6xl px-6 py-10 xl:px-10">
      <PageHeader
        eyebrow={t.home.eyebrow}
        title={session.tenant.name}
        description={isAdmin ? t.home.descriptionAdmin : t.home.descriptionAgent}
      />

      {/* Admin-only: last-30-days performance. */}
      {isAdmin && rate ? (
        <section className="mt-8">
          <p className="eyebrow text-lime-text">{t.home.last30Days}</p>
          <div className="mt-3 grid gap-4 sm:grid-cols-3">
            <StatTile
              label={t.home.resolved}
              value={`${Math.round(rate.resolutionRate * 100)}%`}
              hint={t.home.resolvedOfTemplate
                .replace("{resolved}", rate.resolvedConversations.toLocaleString())
                .replace("{total}", rate.totalConversations.toLocaleString())}
              accent
            />
            <StatTile
              label={t.home.conversations}
              value={rate.totalConversations.toLocaleString()}
              hint={t.home.handledInRange}
            />
            <StatTile
              label={t.home.escalations}
              value={escalationTotal(breakdown).toLocaleString()}
              hint={t.home.handedToHuman}
            />
          </div>

          {breakdown && escalationTotal(breakdown) > 0 ? (
            <EscalationMix
              breakdown={breakdown}
              whyHandedOff={t.home.whyHandedOff}
              locale={locale}
            />
          ) : null}
        </section>
      ) : null}

      {/* Quick access — everyone. */}
      <section className="mt-10">
        <p className="eyebrow text-muted-foreground">{t.home.jumpBackIn}</p>
        <div className="mt-3 grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
          <QuickCard
            href="/tickets"
            icon={<LayoutList className="size-5" />}
            title={t.home.ticketsTitle}
            metric={openTickets}
            metricLabel={openTickets === 1 ? t.home.openTicket : t.home.openTickets}
            body={t.home.ticketsBody}
            cta={t.home.openBoard}
          />
          <QuickCard
            href="/inbox"
            icon={<InboxIcon className="size-5" />}
            title={t.home.inboxTitle}
            metric={`${liveConvos}${liveMore}`}
            metricLabel={t.home.recentConversations}
            body={t.home.inboxBody}
            cta={t.home.openInbox}
          />
          {isAdmin ? (
            <QuickCard
              href="/playground"
              icon={<Sparkles className="size-5" />}
              title={t.home.playgroundTitle}
              body={t.home.playgroundBody}
              cta={t.home.testAgent}
            />
          ) : null}
        </div>
      </section>
    </div>
  );
}

function escalationTotal(breakdown: EscalationBreakdown | null): number {
  if (!breakdown) return 0;
  return Object.values(breakdown).reduce((sum, n) => sum + (n ?? 0), 0);
}

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

function EscalationMix({
  breakdown,
  whyHandedOff,
  locale,
}: {
  breakdown: EscalationBreakdown;
  whyHandedOff: string;
  locale: import("@/lib/i18n/locale").Locale;
}) {
  const entries = Object.entries(breakdown)
    .map(([reason, count]) => ({ reason, count: count ?? 0 }))
    .filter((e) => e.count > 0)
    .sort((a, b) => b.count - a.count);
  const max = Math.max(...entries.map((e) => e.count));

  return (
    <div className="mt-4 rounded-xl border border-border bg-card/60 p-5 backdrop-blur-md">
      <p className="eyebrow text-muted-foreground">{whyHandedOff}</p>
      <div className="mt-4 space-y-2.5">
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
            <span className="w-8 shrink-0 text-end text-sm tabular-nums">
              {count}
            </span>
          </div>
        ))}
      </div>
    </div>
  );
}

function QuickCard({
  href,
  icon,
  title,
  metric,
  metricLabel,
  body,
  cta,
}: {
  href: string;
  icon: React.ReactNode;
  title: string;
  metric?: number | string;
  metricLabel?: string;
  body: string;
  cta: string;
}) {
  return (
    <Link href={href} className="group block">
      <Card className="h-full transition-all duration-200 group-hover:-translate-y-0.5 group-hover:border-lime-ring/60 group-hover:shadow-[0_18px_40px_-32px_var(--lime-ring)]">
        <CardContent className="flex h-full flex-col gap-3">
          <div className="flex items-center justify-between">
            {icon}
            {metric !== undefined ? (
              <span className="font-display text-2xl font-medium tabular-nums">
                {metric}
              </span>
            ) : null}
          </div>
          <div>
            <h2 className="font-medium">{title}</h2>
            {metricLabel ? (
              <p className="text-xs text-muted-foreground">{metricLabel}</p>
            ) : null}
          </div>
          <p className="text-sm text-muted-foreground">{body}</p>
          <span className="mt-auto inline-flex items-center gap-1 pt-2 text-sm font-medium text-lime-text">
            {cta}
            <ArrowRight className="size-4 transition-transform group-hover:translate-x-0.5 rtl:-scale-x-100 rtl:group-hover:-translate-x-0.5" />
          </span>
        </CardContent>
      </Card>
    </Link>
  );
}
