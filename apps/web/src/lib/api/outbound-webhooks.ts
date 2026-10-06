import { apiFetch, browserApiFetch } from "./client";

export const WEBHOOK_EVENTS = [
  "conversation.intake_captured",
  "ticket.created",
  "ticket.resolved",
] as const;
export type WebhookEvent = (typeof WEBHOOK_EVENTS)[number];

export type TenantWebhookRecord = {
  id: string;
  url: string;
  events: WebhookEvent[];
  enabled: boolean;
  lastSuccessAt: string | null;
  lastFailureAt: string | null;
  lastFailureReason: string | null;
};

export type TenantWebhookCreated = TenantWebhookRecord & {
  /** Returned once, at creation — no read path returns it again. */
  secret: string;
};

export function listWebhooks(token?: string) {
  const path = "/outbound/webhooks";
  return token
    ? apiFetch<TenantWebhookRecord[]>(path, { token })
    : browserApiFetch<TenantWebhookRecord[]>(path);
}

export function createWebhook(url: string, events: WebhookEvent[]) {
  return browserApiFetch<TenantWebhookCreated>("/outbound/webhooks", {
    method: "POST",
    json: { url, events },
  });
}

export function deleteWebhook(id: string) {
  return browserApiFetch<{ ok: true }>(`/outbound/webhooks/${id}`, {
    method: "DELETE",
  });
}
