import type { EscalationReason } from "@repo/errors";
import { apiFetch, browserApiFetch } from "./client";

export type TicketStatus = "OPEN" | "CLAIMED" | "RESOLVED";

export type TranscriptMessage = {
  role: "user" | "assistant" | "human_agent";
  content: string;
};

export type Ticket = {
  id: string;
  tenantId: string;
  customerId: string;
  conversationId: string | null;
  escalationReason: EscalationReason;
  status: TicketStatus;
  note: string | null;
  assigneeId: string | null;
  confidence: number | null;
  citedChunkIds: string[] | null;
  claimedAt: string | null;
  resolvedAt: string | null;
  createdAt: string;
  customerPhone: string;
  customerName: string | null;
  transcript: TranscriptMessage[];
};

/**
 * What the mutation endpoints and the SSE stream return — a bare ticket without
 * the customer/transcript context that list/get carry. Merge it onto an existing
 * full ticket rather than replacing, or the card loses its customer fields.
 */
export type TicketBase = Omit<
  Ticket,
  "customerPhone" | "customerName" | "transcript"
>;

/** Fold a base record from a mutation/SSE event onto the fuller list shape. */
export function mergeTicket(existing: Ticket, base: TicketBase): Ticket {
  return { ...existing, ...base };
}

export type TeamMember = { userId: string; email: string; appRole: string };
export type BoardConfig = { stuckTicketThresholdMinutes: number };

/** Board scope tabs. `me` and `unassigned` resolve server-side. */
export type TicketScope = "all" | "me" | "unassigned";

function scopeParam(scope: TicketScope): string {
  if (scope === "me") return "?assignee=me";
  if (scope === "unassigned") return "?assignee=unassigned";
  return "";
}

/** Pass `token` from a server component; omit it in the browser. */
export function listTickets(scope: TicketScope, token?: string) {
  const path = `/kanban/tickets${scopeParam(scope)}`;
  return token
    ? apiFetch<Ticket[]>(path, { token })
    : browserApiFetch<Ticket[]>(path);
}

export function getBoardConfig(token?: string) {
  const path = "/kanban/tickets/config";
  return token
    ? apiFetch<BoardConfig>(path, { token })
    : browserApiFetch<BoardConfig>(path);
}

export function getTeam(token?: string) {
  const path = "/kanban/tickets/team";
  return token
    ? apiFetch<TeamMember[]>(path, { token })
    : browserApiFetch<TeamMember[]>(path);
}

export function getTicket(id: string, token?: string) {
  const path = `/kanban/tickets/${id}`;
  return token
    ? apiFetch<Ticket>(path, { token })
    : browserApiFetch<Ticket>(path);
}

// --- Mutations (browser only — driven by user actions) ---

export function claimTicket(id: string) {
  return browserApiFetch<TicketBase>(`/kanban/tickets/${id}/claim`, {
    method: "POST",
  });
}

export function resolveTicket(id: string) {
  return browserApiFetch<TicketBase>(`/kanban/tickets/${id}/resolve`, {
    method: "POST",
  });
}

export function assignTicket(id: string, assigneeId: string | null) {
  return browserApiFetch<TicketBase>(`/kanban/tickets/${id}/assign`, {
    method: "POST",
    json: { assigneeId },
  });
}
