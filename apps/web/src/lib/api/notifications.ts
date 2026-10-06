import { browserApiFetch } from "./client";
import type { TemplateParams } from "@/lib/i18n/template";

/**
 * Every kind the API records (NOTIFICATION_KINDS in the API's
 * notifications.table.ts). A kind added there before it is added here still
 * renders: the bell falls back to the stored English title/body and a
 * severity icon.
 */
export const NOTIFICATION_KINDS = [
  "ticket_stuck",
  "latency_budget_exceeded",
  "tool_scope_violations",
  "trial_ending",
  "trial_expired",
  "payment_failed",
  "campaign_paused",
  "order_pending_approval",
  "order_store_push_failed",
  "order_auto_mode_review",
  "courier_connection_failing",
  "shipment_template_unusable",
  // Clarly 2.0 S2
  "booking_requested",
  "calendar_needs_reconnect",
] as const;

export type NotificationKind = (typeof NOTIFICATION_KINDS)[number];

export type NotificationSeverity = "warning" | "critical";

/** The values a notification's sentence was written from, so the console can re-render it in the reader's language. */
export type NotificationParams = TemplateParams;

export type NotificationRecord = {
  id: string;
  /** Typed to the known kinds; still checked at runtime, since the API can add one first. */
  kind: NotificationKind;
  severity: NotificationSeverity;
  /** English, written by the API. The fallback whenever `params` or a template is missing. */
  title: string;
  body: string;
  /** `{}` on rows recorded before the API sent params; absent from an API that predates the field. */
  params?: NotificationParams | null;
  entityType: string | null;
  entityId: string | null;
  readAt: string | null;
  createdAt: string;
};

export function getUnreadCount() {
  return browserApiFetch<{ unread: number }>("/notifications/unread-count");
}

export function listNotifications(options: { unreadOnly?: boolean; limit?: number } = {}) {
  const params = new URLSearchParams();
  if (options.unreadOnly) params.set("unreadOnly", "true");
  if (options.limit) params.set("limit", String(options.limit));
  const qs = params.toString();
  return browserApiFetch<NotificationRecord[]>(`/notifications${qs ? `?${qs}` : ""}`);
}

export function markNotificationRead(id: string) {
  return browserApiFetch<{ ok: true }>(`/notifications/${id}/read`, { method: "POST" });
}

export function markAllNotificationsRead() {
  return browserApiFetch<{ marked: number }>("/notifications/read-all", { method: "POST" });
}
