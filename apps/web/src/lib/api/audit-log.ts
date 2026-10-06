import { apiFetch, browserApiFetch } from "./client";
import type { TemplateParams } from "@/lib/i18n/template";

export type AuditOutcome = "success" | "failure";

export type AuditLogEntry = {
  id: string;
  actorUserId: string;
  actorEmail: string | null;
  actorRole: string | null;
  method: string;
  route: string;
  targetId: string | null;
  statusCode: number;
  outcome: AuditOutcome;
  /** English description written by the API. The fallback when `detailKey` has no console template. */
  detail: string | null;
  /** Stable name of what happened (e.g. `order.approved`), so the console can describe it in its own language. Absent on older rows. */
  detailKey?: string | null;
  /** The values `detail` was written from, keyed per `detailKey`. */
  detailParams?: TemplateParams | null;
  createdAt: string;
};

/** Keyset pagination: pass the `createdAt` of the last row to get the next page. */
export function listAuditLog(
  { limit, before }: { limit?: number; before?: string } = {},
  token?: string,
) {
  const params = new URLSearchParams();
  if (limit !== undefined) params.set("limit", String(limit));
  if (before !== undefined) params.set("before", before);
  const qs = params.toString();
  const path = `/audit-log${qs ? `?${qs}` : ""}`;
  return token
    ? apiFetch<AuditLogEntry[]>(path, { token })
    : browserApiFetch<AuditLogEntry[]>(path);
}
