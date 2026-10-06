// Every description a handler can attach to an audit entry, by stable key.
//
// QA 2026-10-05: the console shows the audit log in Arabic or English. A free
// text `detail` can only ever be shown in the language it was written in, so a
// handler now names WHAT happened (`order.approved`) and the values involved;
// the English `detail` is rendered from those same values here. The console
// translates from the key + params and falls back to `detail`.
//
// Keys are a contract with the console: never rename one. Add a new key for a
// new sentence. Params are strings or numbers only, and enumerated values
// (a mode, a role, a courier) are passed raw so the console can translate them.

type Message<P> = (params: P) => string;

function message<P extends Readonly<Record<string, string | number>>>(
  render: Message<P>,
): Message<P> {
  return render;
}

const MESSAGES = {
  'order.approved': message<{
    orderRef: string;
    total: string;
    currency: string;
  }>((p) => `Approved order ${p.orderRef} (${p.total} ${p.currency})`),
  'order.rejected': message<{ orderRef: string; reason: string }>(
    (p) => `Rejected order ${p.orderRef}: ${p.reason}`,
  ),
  'order.cancelled': message<{ orderRef: string }>(
    (p) => `Cancelled order ${p.orderRef}`,
  ),
  'order.store_push_requeued': message<{ orderRef: string }>(
    (p) => `Re-queued the store push for order ${p.orderRef}`,
  ),
  'order_settings.updated': message<{
    mode: string;
    cod: 'enabled' | 'disabled';
    approvalWindowHours: number;
  }>(
    (p) =>
      `Set order mode to "${p.mode}" (cash on delivery ${p.cod}, approval window ${p.approvalWindowHours}h)`,
  ),
  'data_export.requested': message<{ exportId: string }>(
    (p) => `Requested a full data export (${p.exportId})`,
  ),
  'data_export.downloaded': message<{ exportId: string }>(
    (p) => `Downloaded the data export bundle ${p.exportId}`,
  ),
  'courier.connected': message<{ courier: string; accountRef: string }>(
    (p) => `Connected the ${p.courier} courier account ${p.accountRef}`,
  ),
  'courier.saved_inactive': message<{ courier: string; accountRef: string }>(
    (p) => `Saved (inactive) the ${p.courier} courier account ${p.accountRef}`,
  ),
  'courier.deactivated': message<{ connectionId: string }>(
    (p) => `Deactivated courier connection ${p.connectionId}`,
  ),
  'courier.webhook_secret_rotated': message<{ connectionId: string }>(
    (p) =>
      `Rotated the webhook secret for courier connection ${p.connectionId}`,
  ),
  'shipment.recorded': message<{
    courier: string;
    trackingNumber: string;
    orderRef: string;
  }>(
    (p) =>
      `Recorded a ${p.courier} shipment (${p.trackingNumber}) for order ${p.orderRef}`,
  ),
  'delivery_notifications.enabled': message<{ mappedStatuses: number }>(
    (p) =>
      `Set proactive delivery notifications on with ${p.mappedStatuses} mapped status(es)`,
  ),
  'delivery_notifications.disabled': message<{ mappedStatuses: number }>(
    (p) =>
      `Set proactive delivery notifications off with ${p.mappedStatuses} mapped status(es)`,
  ),
  'template_message.not_delivered': message<{ error: string }>(
    (p) => `Template message was not delivered: ${p.error}`,
  ),
  /** `purgeAfter` is an ISO-8601 UTC timestamp. */
  'workspace.closed': message<{ purgeAfter: string }>(
    (p) =>
      `Closed the workspace; data scheduled for erasure after ${p.purgeAfter}`,
  ),
  'workspace.reopened': message<Record<string, never>>(
    () => 'Reopened the workspace before its scheduled erasure',
  ),
  'booking_settings.updated': message<{ mode: string; timeZone: string }>(
    (p) => `Updated booking settings (mode ${p.mode}, time zone ${p.timeZone})`,
  ),
  'booking_service.created': message<{ serviceName: string }>(
    (p) => `Added the bookable service “${p.serviceName}”`,
  ),
  'booking_service.updated': message<{ serviceName: string }>(
    (p) => `Edited the bookable service “${p.serviceName}”`,
  ),
  'booking.created': message<{
    bookingRef: string;
    service: string;
    when: string;
  }>((p) => `Added booking ${p.bookingRef}: ${p.service} on ${p.when}`),
  'booking.confirmed': message<{ bookingRef: string }>(
    (p) => `Confirmed booking ${p.bookingRef}`,
  ),
  'booking.cancelled': message<{ bookingRef: string; reason: string }>(
    (p) =>
      `Cancelled booking ${p.bookingRef}${p.reason ? `: ${p.reason}` : ''}`,
  ),
  'booking.completed': message<{ bookingRef: string }>(
    (p) => `Marked booking ${p.bookingRef} as done`,
  ),
  'booking.no_show': message<{ bookingRef: string }>(
    (p) => `Marked booking ${p.bookingRef} as a no-show`,
  ),
  'calendar.connected': message<{ provider: string; account: string }>(
    (p) => `Connected Google Calendar${p.account ? ` (${p.account})` : ''}`,
  ),
  'calendar.disconnected': message<{ provider: string }>(
    () => `Disconnected Google Calendar`,
  ),
  'widget.updated': message<{ enabled: string; origins: string }>(
    (p) =>
      `Updated the website chat widget (${p.enabled}, ${p.origins} allowed website(s))`,
  ),
  'widget.key_rotated': message<Record<string, never>>(
    () => `Issued a new website chat widget key`,
  ),
  // v2 S1. `fields` is the comma-separated list of profile fields changed.
  'workspace.profile_updated': message<{ fields: string }>(
    (p) => `Updated the workspace profile (${p.fields})`,
  ),
  'kb_document.deleted': message<{ filename: string; chunkCount: number }>(
    (p) =>
      `Deleted knowledge-base document "${p.filename}" (${p.chunkCount} retrieval chunk(s) removed)`,
  ),
  'segment.created': message<{ segmentName: string }>(
    (p) => `Created segment "${p.segmentName}"`,
  ),
  'segment.updated': message<{ segmentId: string }>(
    (p) => `Updated segment ${p.segmentId}`,
  ),
  'segment.deleted': message<{ segmentId: string }>(
    (p) => `Deleted segment ${p.segmentId}`,
  ),
  'campaign.created': message<{ campaignName: string }>(
    (p) => `Created draft campaign "${p.campaignName}"`,
  ),
  'campaign.edited': message<{ campaignName: string }>(
    (p) => `Edited draft campaign "${p.campaignName}"`,
  ),
  /** `scheduledAt` is ISO-8601 UTC. `recipientCount` 0 means the recipient set is not snapshotted yet. */
  'campaign.scheduled': message<{
    campaignName: string;
    scheduledAt: string;
    recipientCount: number;
  }>(
    (p) =>
      `Scheduled campaign "${p.campaignName}" for ${p.scheduledAt} to ${recipientSet(p.recipientCount)} recipient set`,
  ),
  'campaign.scheduled_immediate': message<{
    campaignName: string;
    recipientCount: number;
  }>(
    (p) =>
      `Scheduled campaign "${p.campaignName}" for immediate send to ${recipientSet(p.recipientCount)} recipient set`,
  ),
  'campaign.paused': message<{ campaignName: string }>(
    (p) => `Paused campaign "${p.campaignName}"`,
  ),
  'campaign.resumed': message<{ campaignName: string }>(
    (p) => `Resumed campaign "${p.campaignName}"`,
  ),
  'campaign.canceled': message<{ campaignName: string }>(
    (p) => `Canceled campaign "${p.campaignName}"`,
  ),
  'team.role_changed': message<{ email: string; role: string }>(
    (p) => `Changed ${p.email}'s role to ${p.role}`,
  ),
  'team.member_removed': message<{ userId: string; releasedTickets: number }>(
    (p) =>
      `Removed member ${p.userId} from the workspace (${p.releasedTickets} unresolved ticket(s) released)`,
  ),
  'customer.label_overridden': message<{ customerId: string; label: string }>(
    (p) => `Overrode customer ${p.customerId}'s label to "${p.label}"`,
  ),
  'customer.label_cleared': message<{ customerId: string }>(
    (p) =>
      `Cleared the label override on customer ${p.customerId}, returning it to the agent`,
  ),
  'consent.opted_out': message<{ phone: string }>(
    (p) => `Recorded an opt-out for ${p.phone} on the customer's behalf`,
  ),
  'consent.opted_in': message<{ phone: string }>(
    (p) => `Recorded consent to message ${p.phone} again`,
  ),
  'marketing_consent.opted_out': message<{ customerId: string }>(
    (p) => `Recorded a marketing opt-out for customer ${p.customerId}`,
  ),
  'marketing_consent.cleared': message<{ customerId: string }>(
    (p) => `Cleared the marketing opt-out for customer ${p.customerId}`,
  ),
} as const;

function recipientSet(count: number): string {
  return count > 0 ? String(count) : 'an unsnapshotted';
}

export type AuditDetailKey = keyof typeof MESSAGES;
export type AuditDetailParams<K extends AuditDetailKey> = Parameters<
  (typeof MESSAGES)[K]
>[0];

export const AUDIT_DETAIL_KEYS = Object.keys(MESSAGES) as AuditDetailKey[];

/** The English `detail` stored beside the key. */
export function renderAuditDetail<K extends AuditDetailKey>(
  key: K,
  params: AuditDetailParams<K>,
): string {
  const render = MESSAGES[key] as Message<AuditDetailParams<K>>;
  return render(params);
}
