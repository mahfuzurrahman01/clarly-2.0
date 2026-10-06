"use client";

import { AlertTriangle, Loader2 } from "lucide-react";
import type { Ticket } from "@/lib/api/kanban";
import { escalationLabel } from "@/lib/tickets/escalation";
import { contactNameDir } from "@/lib/i18n/bidi";
import { isStuck, confidencePct } from "@/lib/tickets/format";
import { compactAge } from "@/lib/i18n/relative-time";
import { useLocale, useTranslations } from "@/lib/i18n/provider";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

type TicketCardProps = {
  ticket: Ticket;
  assigneeEmail?: string;
  thresholdMinutes: number;
  busy: boolean;
  now: number;
  onOpen: () => void;
  onClaim: () => void;
  onResolve: () => void;
};

export function TicketCard({
  ticket,
  assigneeEmail,
  thresholdMinutes,
  busy,
  now,
  onOpen,
  onClaim,
  onResolve,
}: TicketCardProps) {
  const t = useTranslations();
  const locale = useLocale();
  const stuck = isStuck(ticket, thresholdMinutes, now);
  const conf = confidencePct(ticket.confidence);
  const stamp = ticket.resolvedAt ?? ticket.claimedAt ?? ticket.createdAt;

  function stop(e: React.MouseEvent) {
    e.stopPropagation();
  }

  return (
    <div
      role="button"
      tabIndex={0}
      onClick={onOpen}
      onKeyDown={(e) => {
        if (e.key === "Enter" || e.key === " ") {
          e.preventDefault();
          onOpen();
        }
      }}
      className={cn(
        "group flex cursor-pointer flex-col gap-3 rounded-xl border bg-card p-4 text-start transition-all duration-200",
        "hover:-translate-y-0.5 hover:shadow-[0_16px_40px_-32px_rgba(10,10,10,0.5)] focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none",
        stuck ? "border-destructive/40" : "border-border hover:border-foreground/25",
      )}
    >
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <p dir={contactNameDir(ticket.customerName)} className="truncate text-start text-sm font-medium">
            {ticket.customerName ?? ticket.customerPhone}
          </p>
          {ticket.customerName ? (
            <p className="truncate text-xs text-muted-foreground">
              <bdi dir="ltr">{ticket.customerPhone}</bdi>
            </p>
          ) : null}
        </div>
        {stuck ? (
          <span className="inline-flex items-center gap-1 text-xs font-medium text-destructive">
            <AlertTriangle className="size-3.5" />
            {t.tickets.stuck}
          </span>
        ) : (
          <time
            dateTime={stamp}
            className="shrink-0 text-xs tabular-nums text-muted-foreground"
          >
            {compactAge(stamp, locale, now)}
          </time>
        )}
      </div>

      <div className="flex flex-wrap items-center gap-2">
        <span className="inline-flex items-center gap-1.5 rounded-md bg-secondary px-2 py-1 text-xs">
          <span className="size-1.5 rounded-full bg-signal" />
          {escalationLabel(ticket.escalationReason, locale)}
        </span>
        {conf ? (
          <span className="eyebrow text-muted-foreground">
            {t.tickets.confidenceAbbrev} {conf}
          </span>
        ) : null}
      </div>

      {ticket.assigneeId ? (
        <p className="truncate text-xs text-muted-foreground">
          {assigneeEmail ?? t.tickets.assigned}
        </p>
      ) : null}

      {ticket.status !== "RESOLVED" ? (
        <div className="flex items-center gap-2 pt-1" onClick={stop}>
          {ticket.status === "OPEN" ? (
            <Button size="sm" onClick={onClaim} disabled={busy}>
              {busy ? <Loader2 className="size-3.5 animate-spin" /> : null}
              {t.tickets.claim}
            </Button>
          ) : null}
          <Button
            size="sm"
            variant={ticket.status === "CLAIMED" ? "default" : "outline"}
            onClick={onResolve}
            disabled={busy}
          >
            {t.tickets.resolve}
          </Button>
        </div>
      ) : null}
    </div>
  );
}
