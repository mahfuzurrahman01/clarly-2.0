"use client";

import { useState } from "react";
import { AlertTriangle, CheckCircle2, Loader2 } from "lucide-react";
import { toast } from "sonner";
import { type AuditLogEntry, listAuditLog } from "@/lib/api/audit-log";
import { auditActionLabel } from "@/lib/audit/actions";
import { useLocale, useTranslations } from "@/lib/i18n/provider";
import { auditDetailText } from "./audit-detail-copy";
import { Button } from "@/components/ui/button";

const PAGE_SIZE = 50;

function OutcomeBadge({ outcome }: { outcome: AuditLogEntry["outcome"] }) {
  const t = useTranslations();
  if (outcome === "success") {
    return (
      <span className="inline-flex items-center gap-1 rounded-full border border-lime-ring/40 bg-lime-soft/70 px-2 py-0.5 text-xs text-lime-text">
        <CheckCircle2 className="size-3" />
        {t.auditLog.outcomeSuccess}
      </span>
    );
  }
  return (
    <span className="inline-flex items-center gap-1 rounded-full border border-destructive/40 bg-destructive/5 px-2 py-0.5 text-xs text-destructive">
      <AlertTriangle className="size-3" />
      {t.auditLog.outcomeFailure}
    </span>
  );
}

/** Readable action name, with the raw route kept underneath for whoever needs to trace it. */
function AuditAction({ method, route }: { method: string; route: string }) {
  const t = useTranslations();
  const raw = `${method} ${route}`;
  const label = auditActionLabel(method, route, t);
  if (!label) {
    return (
      <p className="font-mono text-xs">
        <bdi dir="ltr">{raw}</bdi>
      </p>
    );
  }
  return (
    <>
      <p className="text-xs">{label}</p>
      <p className="mt-0.5 font-mono text-[0.6875rem] text-muted-foreground">
        <bdi dir="ltr">{raw}</bdi>
      </p>
    </>
  );
}

export function AuditLogViewer({
  initialEntries,
}: {
  initialEntries: AuditLogEntry[];
}) {
  const t = useTranslations();
  const locale = useLocale();
  const [entries, setEntries] = useState(initialEntries);
  const [loadingMore, setLoadingMore] = useState(false);
  const [exhausted, setExhausted] = useState(initialEntries.length < PAGE_SIZE);

  async function loadMore() {
    const last = entries[entries.length - 1];
    if (!last) return;
    setLoadingMore(true);
    try {
      const next = await listAuditLog({
        limit: PAGE_SIZE,
        before: last.createdAt,
      });
      setEntries((prev) => [...prev, ...next]);
      if (next.length < PAGE_SIZE) setExhausted(true);
    } catch {
      toast.error(t.auditLog.couldNotLoadMore);
    } finally {
      setLoadingMore(false);
    }
  }

  if (entries.length === 0) {
    return <p className="text-sm text-muted-foreground">{t.auditLog.empty}</p>;
  }

  return (
    <div className="space-y-6">
      <div className="relative overflow-x-auto rounded-xl border border-border">
        <table className="w-full text-sm">
          <thead className="bg-secondary/60 text-xs text-muted-foreground">
            <tr>
              <th className="px-4 py-2 text-start font-medium">{t.auditLog.colTime}</th>
              <th className="px-4 py-2 text-start font-medium">{t.auditLog.colActor}</th>
              <th className="px-4 py-2 text-start font-medium">{t.auditLog.colAction}</th>
              <th className="px-4 py-2 text-start font-medium">{t.auditLog.colTarget}</th>
              <th className="px-4 py-2 text-start font-medium">{t.auditLog.colOutcome}</th>
            </tr>
          </thead>
          <tbody>
            {entries.map((entry) => {
              const detail = auditDetailText(entry, t, locale);
              return (
                <tr key={entry.id} className="border-t border-border align-top">
                  <td className="whitespace-nowrap px-4 py-3 text-xs text-muted-foreground">
                    {new Date(entry.createdAt).toLocaleString()}
                  </td>
                  <td className="px-4 py-3">
                    <p className="text-xs">{entry.actorEmail ?? t.auditLog.actorGone}</p>
                    {entry.actorRole ? (
                      <p className="mt-0.5 text-xs text-muted-foreground">{entry.actorRole}</p>
                    ) : null}
                  </td>
                  <td className="px-4 py-3">
                    <AuditAction method={entry.method} route={entry.route} />
                    {detail ? (
                      <p dir="auto" className="mt-0.5 text-start text-xs text-muted-foreground">
                        {detail}
                      </p>
                    ) : null}
                  </td>
                  <td className="px-4 py-3 font-mono text-xs text-muted-foreground">
                    {entry.targetId ?? "—"}
                  </td>
                  <td className="px-4 py-3">
                    <OutcomeBadge outcome={entry.outcome} />
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      {!exhausted ? (
        <div className="flex justify-center">
          <Button variant="outline" size="sm" onClick={loadMore} disabled={loadingMore}>
            {loadingMore ? <Loader2 className="size-3.5 animate-spin" /> : null}
            {t.auditLog.loadMore}
          </Button>
        </div>
      ) : null}
    </div>
  );
}
