"use client";

import { useCallback, useEffect, useMemo, useRef, useState, useTransition } from "react";
import { useSearchParams } from "next/navigation";
import { toast } from "sonner";
import {
  type Ticket,
  type TicketBase,
  type TicketScope,
  type TicketStatus,
  type TeamMember,
  type BoardConfig,
  listTickets,
  claimTicket,
  resolveTicket,
  assignTicket,
  mergeTicket,
} from "@/lib/api/kanban";
import { ApiError } from "@/lib/api/client";
import { apiErrorMessage } from "@/lib/api/error-message";
import { useTicketStream } from "@/lib/tickets/use-ticket-stream";
import { useTranslations } from "@/lib/i18n/provider";
import { cn } from "@/lib/utils";
import { TicketCard } from "./ticket-card";
import { TicketDetail } from "./ticket-detail";

type TicketsBoardProps = {
  initialTickets: Ticket[];
  config: BoardConfig;
  team: TeamMember[];
  currentUserId: string;
  now: number;
};

export function TicketsBoard({
  initialTickets,
  config,
  team,
  currentUserId,
  now: initialNow,
}: TicketsBoardProps) {
  const t = useTranslations();
  const SCOPES: { value: TicketScope; label: string }[] = [
    { value: "all", label: t.tickets.scopeAll },
    { value: "me", label: t.tickets.scopeMine },
    { value: "unassigned", label: t.tickets.scopeUnassigned },
  ];
  const COLUMNS: { status: TicketStatus; label: string; empty: string }[] = [
    { status: "OPEN", label: t.tickets.columnOpen, empty: t.tickets.emptyOpen },
    { status: "CLAIMED", label: t.tickets.columnClaimed, empty: t.tickets.emptyClaimed },
    { status: "RESOLVED", label: t.tickets.columnResolved, empty: t.tickets.emptyResolved },
  ];
  const [tickets, setTickets] = useState(initialTickets);
  const [scope, setScope] = useState<TicketScope>("all");
  const [busyIds, setBusyIds] = useState<Set<string>>(new Set());
  const searchParams = useSearchParams();
  const [selectedId, setSelectedId] = useState<string | null>(
    () => searchParams.get("ticket"),
  );
  const [now, setNow] = useState(initialNow);
  const [pending, startTransition] = useTransition();

  const scopeRef = useRef(scope);

  useEffect(() => {
    scopeRef.current = scope;
  }, [scope]);

  // Keep relative times fresh without breaking first-render hydration.
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 60_000);
    return () => clearInterval(t);
  }, []);

  const emailByUser = useMemo(() => {
    const map = new Map<string, string>();
    team.forEach((m) => map.set(m.userId, m.email));
    return map;
  }, [team]);

  const refetch = useCallback((next: TicketScope) => {
    startTransition(async () => {
      try {
        setTickets(await listTickets(next));
      } catch {
        toast.error(t.tickets.couldNotLoadTickets);
      }
    });
  }, []);

  function changeScope(next: TicketScope) {
    if (next === scope) return;
    setScope(next);
    refetch(next);
  }

  // --- SSE: patch known tickets in place; refetch when a new one appears. ---
  const onStream = useCallback(
    (base: TicketBase) => {
      setTickets((prev) => {
        const idx = prev.findIndex((t) => t.id === base.id);
        if (idx === -1) {
          refetch(scopeRef.current);
          return prev;
        }
        const next = [...prev];
        next[idx] = mergeTicket(next[idx], base);
        return next;
      });
    },
    [refetch],
  );
  const connected = useTicketStream(onStream);

  function setBusy(id: string, on: boolean) {
    setBusyIds((prev) => {
      const next = new Set(prev);
      if (on) next.add(id);
      else next.delete(id);
      return next;
    });
  }

  // Optimistically patch a ticket, run the mutation, roll back on failure.
  async function mutate(
    id: string,
    optimistic: Partial<Ticket>,
    call: () => Promise<TicketBase>,
    conflictMessage: string,
  ) {
    const snapshot = tickets;
    setBusy(id, true);
    setTickets((prev) =>
      prev.map((t) => (t.id === id ? { ...t, ...optimistic } : t)),
    );

    try {
      const base = await call();
      setTickets((prev) =>
        prev.map((t) => (t.id === id ? mergeTicket(t, base) : t)),
      );
    } catch (err) {
      setTickets(snapshot);
      const msg =
        err instanceof ApiError && err.status === 409
          ? conflictMessage
          : apiErrorMessage(err, t, t.tickets.somethingWentWrong);
      toast.error(msg);
    } finally {
      setBusy(id, false);
    }
  }

  function claim(id: string) {
    return mutate(
      id,
      { status: "CLAIMED", assigneeId: currentUserId, claimedAt: new Date().toISOString() },
      () => claimTicket(id),
      t.tickets.alreadyClaimed,
    );
  }

  function resolve(id: string) {
    return mutate(
      id,
      { status: "RESOLVED", resolvedAt: new Date().toISOString() },
      () => resolveTicket(id),
      t.tickets.alreadyResolved,
    );
  }

  function assign(id: string, assigneeId: string | null) {
    return mutate(
      id,
      assigneeId
        ? { status: "CLAIMED", assigneeId, claimedAt: new Date().toISOString() }
        : { status: "OPEN", assigneeId: null, claimedAt: null },
      () => assignTicket(id, assigneeId),
      t.tickets.cantReassignResolved,
    );
  }

  const selected = tickets.find((t) => t.id === selectedId) ?? null;

  const byStatus = useMemo(() => {
    const groups: Record<TicketStatus, Ticket[]> = {
      OPEN: [],
      CLAIMED: [],
      RESOLVED: [],
    };
    for (const t of tickets) groups[t.status].push(t);
    for (const status of Object.keys(groups) as TicketStatus[]) {
      groups[status].sort((a, b) => b.createdAt.localeCompare(a.createdAt));
    }
    return groups;
  }, [tickets]);

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-center justify-between gap-3">
        {/* Scope segmented control */}
        <div
          role="tablist"
          aria-label={t.tickets.scopeAriaLabel}
          className="inline-flex rounded-lg border border-border p-0.5"
        >
          {SCOPES.map((s) => (
            <button
              key={s.value}
              role="tab"
              aria-selected={scope === s.value}
              onClick={() => changeScope(s.value)}
              className={cn(
                "rounded-md px-3 py-1.5 text-sm transition-colors focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none",
                scope === s.value
                  ? "bg-secondary font-medium text-foreground"
                  : "text-muted-foreground hover:text-foreground",
              )}
            >
              {s.label}
            </button>
          ))}
        </div>

        <span
          className="inline-flex items-center gap-1.5 text-xs text-muted-foreground"
          aria-live="polite"
        >
          <span
            className={cn(
              "size-1.5 rounded-full",
              connected ? "bg-signal" : "bg-muted-foreground/40",
            )}
          />
          {connected ? t.tickets.live : t.tickets.streamOffline}
        </span>
      </div>

      <div
        className={cn(
          "grid gap-4 transition-opacity md:grid-cols-3",
          pending && "pointer-events-none opacity-60",
        )}
      >
        {COLUMNS.map((col) => {
          const items = byStatus[col.status];
          return (
            <section key={col.status} className="flex flex-col gap-3">
              <div className="flex items-center justify-between">
                <h2 className="text-sm font-medium">{col.label}</h2>
                <span className="text-xs tabular-nums text-muted-foreground">
                  {items.length}
                </span>
              </div>
              <div className="flex flex-col gap-3">
                {items.length === 0 ? (
                  <p className="rounded-xl border border-dashed border-border p-4 text-sm text-muted-foreground">
                    {col.empty}
                  </p>
                ) : (
                  items.map((ticket) => (
                    <TicketCard
                      key={ticket.id}
                      ticket={ticket}
                      assigneeEmail={
                        ticket.assigneeId
                          ? emailByUser.get(ticket.assigneeId)
                          : undefined
                      }
                      thresholdMinutes={config.stuckTicketThresholdMinutes}
                      busy={busyIds.has(ticket.id)}
                      now={now}
                      onOpen={() => setSelectedId(ticket.id)}
                      onClaim={() => claim(ticket.id)}
                      onResolve={() => resolve(ticket.id)}
                    />
                  ))
                )}
              </div>
            </section>
          );
        })}
      </div>

      <TicketDetail
        ticket={selected}
        open={selectedId !== null}
        onOpenChange={(open) => !open && setSelectedId(null)}
        team={team}
        busy={selected ? busyIds.has(selected.id) : false}
        onClaim={() => selected && claim(selected.id)}
        onResolve={() => selected && resolve(selected.id)}
        onAssign={(assigneeId) => selected && assign(selected.id, assigneeId)}
      />
    </div>
  );
}
