import type { Dictionary } from "@/lib/i18n/get-dictionary";

export type AuditActionKey = keyof Dictionary["auditLog"]["actions"];

/**
 * Audit rows store the Nest route template (`POST /kanban/tickets/:id/resolve`),
 * which is precise but unreadable for a merchant. Known routes map to a
 * localised action name; anything not listed (a route added after this map)
 * falls back to the raw template so nothing is ever hidden.
 */
const AUDIT_ROUTE_ACTIONS: Readonly<Record<string, AuditActionKey>> = {
  "POST /auth/login": "signIn",
  "POST /agents": "agentCreate",
  "PATCH /agents/:id": "agentUpdate",
  "POST /agents/:id/archive": "agentArchive",
  "POST /agents/:id/publish": "agentPublish",
  "POST /agents/:id/sandbox": "agentSandbox",
  "PUT /agents/:id/knowledge": "agentKnowledgeScope",
  "POST /billing/checkout": "billingCheckout",
  "POST /billing/portal": "billingPortal",
  "POST /billing/cancel": "billingCancel",
  "POST /campaigns": "campaignCreate",
  "PUT /campaigns/:id": "campaignUpdate",
  "POST /campaigns/:id/schedule": "campaignSchedule",
  "POST /campaigns/:id/pause": "campaignPause",
  "POST /campaigns/:id/resume": "campaignResume",
  "POST /campaigns/:id/cancel": "campaignCancel",
  "POST /segments": "segmentCreate",
  "PUT /segments/:id": "segmentUpdate",
  "DELETE /segments/:id": "segmentDelete",
  "POST /segments/:id/preview": "segmentPreview",
  "POST /catalog/products": "productCreate",
  "POST /catalog/products/import": "productImport",
  "PATCH /catalog/products/:id": "productUpdate",
  "POST /catalog/products/:id/image": "productImage",
  "DELETE /catalog/products/:id": "productDelete",
  "POST /channels/meta": "metaChannelConnect",
  "POST /channels/meta/pages": "metaPagesList",
  "DELETE /channels/meta/:id": "metaChannelDisconnect",
  "POST /whatsapp/connect/embedded-signup": "whatsappConnect",
  "PUT /comment-automation/settings": "commentSettings",
  "PUT /comment-automation/posts": "commentPosts",
  "DELETE /comment-automation/posts/:id": "commentPostRemove",
  "POST /conversations/:id/messages": "replySend",
  "POST /conversations/:id/template-messages": "templateMessageSend",
  "POST /conversations/:id/messages/:messageId/feedback": "feedbackRate",
  "DELETE /conversations/:id/messages/:messageId/feedback": "feedbackClear",
  "POST /conversations/:id/handover": "handoverTake",
  "POST /conversations/:id/handover/return": "handoverReturn",
  "PUT /customers/:customerId/label": "customerLabelSet",
  "DELETE /customers/:customerId/label": "customerLabelClear",
  "PATCH /customers/:customerId/marketing-consent": "marketingConsent",
  "PUT /customers/consent": "consentUpdate",
  "POST /couriers/connections": "courierConnect",
  "DELETE /couriers/connections/:id": "courierDisconnect",
  "POST /couriers/connections/:id/webhook-secret": "courierSecret",
  "POST /orders/:orderId/shipments": "shipmentCreate",
  "PUT /settings/delivery-notifications": "deliveryNotifications",
  "POST /data-exports": "dataExportRequest",
  "POST /kanban/tickets/:id/claim": "ticketClaim",
  "POST /kanban/tickets/:id/assign": "ticketAssign",
  "POST /kanban/tickets/:id/resolve": "ticketResolve",
  "POST /knowledge-base/documents": "kbUpload",
  "DELETE /knowledge-base/documents/:id": "kbDelete",
  "POST /notifications/:id/read": "notificationRead",
  "POST /notifications/read-all": "notificationsReadAll",
  "POST /onboarding/signup": "signup",
  "POST /onboarding/team/invite": "teamInvite",
  "PATCH /onboarding/team/:userId": "teamUpdate",
  "DELETE /onboarding/team/:userId": "teamRemove",
  "PATCH /onboarding/tenant-policy": "policyUpdate",
  "DELETE /onboarding/tenant": "workspaceClose",
  "POST /onboarding/tenant/reopen": "workspaceReopen",
  "PATCH /orders/settings": "orderSettingsUpdate",
  "POST /orders/:id/approve": "orderApprove",
  "POST /orders/:id/reject": "orderReject",
  "POST /orders/:id/cancel": "orderCancel",
  "POST /orders/:id/retry-store-push": "orderRetryStorePush",
  "POST /outbound/webhooks": "webhookCreate",
  "DELETE /outbound/webhooks/:id": "webhookDelete",
  "POST /store/connect/:provider": "storeConnect",
  "POST /store/disconnect/:connectionId": "storeDisconnect",
  "POST /store/connections/:connectionId/webhook-secret": "storeSecret",
  "POST /templates": "templateCreate",
  "PATCH /templates/:id": "templateUpdate",
  "DELETE /templates/:id": "templateDelete",
  "POST /templates/:id/submit": "templateSubmit",
  "POST /templates/:id/preview": "templatePreview",
  "POST /templates/sync": "templateSync",
};

function normalise(method: string, route: string): string {
  const path = route.length > 1 ? route.replace(/\/+$/, "") : route;
  return `${method.toUpperCase()} ${path}`;
}

/** The localised action name for an audit row, or null when the route is not mapped. */
export function auditActionLabel(
  method: string,
  route: string,
  t: Dictionary,
): string | null {
  const key = AUDIT_ROUTE_ACTIONS[normalise(method, route)];
  return key ? t.auditLog.actions[key] : null;
}
