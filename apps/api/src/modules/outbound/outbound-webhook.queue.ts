export const OUTBOUND_WEBHOOK_QUEUE = 'outbound-webhook';

export interface OutboundWebhookJobData {
  tenantId: string;
  webhookId: string;
  event: string;
  body: Record<string, unknown>;
}
