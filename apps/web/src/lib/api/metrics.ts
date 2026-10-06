import type { EscalationReason } from "@repo/errors";
import { apiFetch, browserApiFetch } from "./client";

export type ResolutionRate = {
  from: string;
  to: string;
  totalConversations: number;
  resolvedConversations: number;
  /** 0..1 — the share of conversations resolved in the window. */
  resolutionRate: number;
};

/** Partial: only reasons that occurred in the window appear as keys. */
export type EscalationBreakdown = Partial<Record<EscalationReason, number>>;

/** `from`/`to` are ISO calendar dates (YYYY-MM-DD), inclusive. */
function rangeQuery(from: string, to: string): string {
  return `?from=${from}&to=${to}`;
}

export function getResolutionRate(from: string, to: string, token?: string) {
  const path = `/metrics/resolution-rate${rangeQuery(from, to)}`;
  return token
    ? apiFetch<ResolutionRate>(path, { token })
    : browserApiFetch<ResolutionRate>(path);
}

export function getEscalationBreakdown(from: string, to: string, token?: string) {
  const path = `/metrics/escalation-breakdown${rangeQuery(from, to)}`;
  return token
    ? apiFetch<EscalationBreakdown>(path, { token })
    : browserApiFetch<EscalationBreakdown>(path);
}

/** The subset of EscalationReason a tenant can fix by writing or reconciling a document. */
export type KnowledgeGapReason =
  | "KB_NOT_INDEXED"
  | "CONFIDENCE_BELOW_THRESHOLD"
  | "KB_CONFLICT";

export type KnowledgeGap = {
  reason: KnowledgeGapReason;
  /** Null once the transcript has been purged — the escalation still counts, the wording is gone. */
  question: string | null;
  occurredAt: string;
  conversationId: string | null;
};

export type KnowledgeGapReport = {
  gaps: KnowledgeGap[];
  totals: { reason: KnowledgeGapReason; count: number }[];
};

export function getKnowledgeGapReport(
  from: string,
  to: string,
  limit: number | undefined,
  token?: string,
) {
  const params = new URLSearchParams({ from, to });
  if (limit !== undefined) params.set("limit", String(limit));
  const path = `/metrics/knowledge-gaps?${params.toString()}`;
  return token
    ? apiFetch<KnowledgeGapReport>(path, { token })
    : browserApiFetch<KnowledgeGapReport>(path);
}
