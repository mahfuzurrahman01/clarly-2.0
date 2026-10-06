"use client";

import Link from "next/link";
import { ArrowUpRight, Loader2 } from "lucide-react";
import type { Ticket, TeamMember } from "@/lib/api/kanban";
import { escalationLabel } from "@/lib/tickets/escalation";
import { contactNameDir } from "@/lib/i18n/bidi";
import { confidencePct } from "@/lib/tickets/format";
import { relativeAgo } from "@/lib/i18n/relative-time";
import { useLocale, useTranslations } from "@/lib/i18n/provider";
import {
  Sheet,
  SheetContent,
  SheetHeader,
  SheetTitle,
} from "@/components/ui/sheet";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

const UNASSIGNED = "__unassigned__";

type TicketDetailProps = {
  ticket: Ticket | null;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  team: TeamMember[];
  busy: boolean;
  onClaim: () => void;
  onResolve: () => void;
  onAssign: (assigneeId: string | null) => void;
};

export function TicketDetail({
  ticket,
  open,
  onOpenChange,
  team,
  busy,
  onClaim,
  onResolve,
  onAssign,
}: TicketDetailProps) {
  const t = useTranslations();
  const locale = useLocale();
  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent
        side="inline-end"
        className="flex w-full flex-col gap-0 overflow-y-auto p-0 sm:max-w-md"
      >
        {ticket ? (
          <>
            <SheetHeader className="gap-1 border-b border-border p-6">
              <SheetTitle className="font-display text-2xl font-medium tracking-tight">
                <bdi dir={contactNameDir(ticket.customerName)}>
                  {ticket.customerName ?? ticket.customerPhone}
                </bdi>
              </SheetTitle>
              <p className="text-sm text-muted-foreground">
                <bdi dir="ltr">{ticket.customerPhone}</bdi> ·{" "}
                {t.tickets.openedAgoTemplate.replace(
                  "{age}",
                  relativeAgo(ticket.createdAt, locale),
                )}
              </p>
            </SheetHeader>

            <div className="flex flex-col gap-6 p-6">
              {/* Meta */}
              <dl className="grid grid-cols-2 gap-4 text-sm">
                <Meta label={t.tickets.status} value={ticket.status} />
                <Meta
                  label={t.tickets.reason}
                  value={escalationLabel(ticket.escalationReason, locale)}
                />
                <Meta
                  label={t.tickets.confidence}
                  value={confidencePct(ticket.confidence) ?? "—"}
                />
                <div className="space-y-1">
                  <dt className="eyebrow text-muted-foreground">
                    {t.tickets.conversation}
                  </dt>
                  <dd className="text-sm">
                    {ticket.conversationId ? (
                      <Link
                        href={`/inbox/${ticket.conversationId}`}
                        className="inline-flex items-center gap-1 text-foreground underline underline-offset-4"
                      >
                        {t.tickets.openInInbox}
                        <ArrowUpRight className="size-3.5" />
                      </Link>
                    ) : (
                      t.tickets.none
                    )}
                  </dd>
                </div>
              </dl>

              {/* Assignee */}
              <div className="space-y-2">
                <p className="eyebrow text-muted-foreground">{t.tickets.assignedTo}</p>
                <Select
                  value={ticket.assigneeId ?? UNASSIGNED}
                  onValueChange={(v) =>
                    onAssign(v === UNASSIGNED ? null : (v as string))
                  }
                  disabled={busy || ticket.status === "RESOLVED"}
                >
                  <SelectTrigger className="w-full">
                    <SelectValue placeholder={t.tickets.unassigned}>
                      {() =>
                        ticket.assigneeId
                          ? (team.find((m) => m.userId === ticket.assigneeId)?.email ??
                            t.tickets.unassigned)
                          : t.tickets.unassigned
                      }
                    </SelectValue>
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value={UNASSIGNED}>{t.tickets.unassigned}</SelectItem>
                    {team.map((m) => (
                      <SelectItem key={m.userId} value={m.userId}>
                        {m.email}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
                {team.length === 0 ? (
                  <p className="text-xs text-muted-foreground">
                    {t.tickets.noTeammates}
                  </p>
                ) : null}
              </div>

              {/* Actions */}
              {ticket.status !== "RESOLVED" ? (
                <div className="flex items-center gap-2">
                  {ticket.status === "OPEN" ? (
                    <Button onClick={onClaim} disabled={busy}>
                      {busy ? <Loader2 className="size-4 animate-spin" /> : null}
                      {t.tickets.claim}
                    </Button>
                  ) : null}
                  <Button
                    variant={ticket.status === "CLAIMED" ? "default" : "outline"}
                    onClick={onResolve}
                    disabled={busy}
                  >
                    {t.tickets.resolve}
                  </Button>
                </div>
              ) : null}

              {/* Transcript */}
              <div className="space-y-3">
                <p className="eyebrow text-muted-foreground">
                  {t.tickets.recentMessages}
                </p>
                {ticket.transcript.length === 0 ? (
                  <p className="text-sm text-muted-foreground">
                    {t.tickets.noConversationAttached}
                  </p>
                ) : (
                  <div className="flex flex-col gap-2">
                    {ticket.transcript.map((m, i) => (
                      <Message key={i} role={m.role} content={m.content} />
                    ))}
                  </div>
                )}
              </div>

              {/* Citations — ids only; no resolver endpoint yet. */}
              {ticket.citedChunkIds && ticket.citedChunkIds.length > 0 ? (
                <div className="space-y-2">
                  <p className="eyebrow text-muted-foreground">
                    {t.tickets.citedSources}
                  </p>
                  <div className="flex flex-wrap gap-1.5">
                    {ticket.citedChunkIds.map((id) => (
                      <code
                        key={id}
                        className="rounded bg-secondary px-1.5 py-0.5 font-mono text-[0.6875rem] text-muted-foreground"
                      >
                        {id.slice(0, 8)}
                      </code>
                    ))}
                  </div>
                </div>
              ) : null}
            </div>
          </>
        ) : null}
      </SheetContent>
    </Sheet>
  );
}

function Meta({ label, value }: { label: string; value: string }) {
  return (
    <div className="space-y-1">
      <dt className="eyebrow text-muted-foreground">{label}</dt>
      <dd className="text-sm">{value}</dd>
    </div>
  );
}

function Message({
  role,
  content,
}: {
  role: "user" | "assistant" | "human_agent";
  content: string;
}) {
  const t = useTranslations();
  const outgoing = role !== "user";
  return (
    <div
      className={cn("flex flex-col", outgoing ? "items-end" : "items-start")}
    >
      <div
        className={cn(
          "max-w-[85%] rounded-2xl px-3 py-2 text-sm leading-relaxed",
          outgoing
            ? "rounded-ee-sm bg-ink text-paper"
            : "rounded-es-sm bg-muted text-foreground",
        )}
      >
        {content}
      </div>
      {role === "human_agent" ? (
        <span className="eyebrow mt-1 text-muted-foreground">{t.tickets.human}</span>
      ) : null}
    </div>
  );
}
