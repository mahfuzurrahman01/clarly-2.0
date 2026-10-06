import {
  AUDIT_DETAIL_KEYS,
  renderAuditDetail,
  type AuditDetailKey,
  type AuditDetailParams,
} from './audit-detail-catalog';

/**
 * The English `detail` an entry stores must be exactly what each handler wrote
 * before keys existed, so these are golden strings copied from the previous
 * call sites. The params are what the console localises from.
 */
const GOLDEN: {
  [K in AuditDetailKey]: { params: AuditDetailParams<K>; english: string };
} = {
  'order.approved': {
    params: { orderRef: 'ORD-AV96KJ', total: '62.00', currency: 'SAR' },
    english: 'Approved order ORD-AV96KJ (62.00 SAR)',
  },
  'order.rejected': {
    params: { orderRef: 'ORD-AV96KJ', reason: 'duplicate order' },
    english: 'Rejected order ORD-AV96KJ: duplicate order',
  },
  'order.cancelled': {
    params: { orderRef: 'ORD-AV96KJ' },
    english: 'Cancelled order ORD-AV96KJ',
  },
  'order.store_push_requeued': {
    params: { orderRef: 'ORD-AV96KJ' },
    english: 'Re-queued the store push for order ORD-AV96KJ',
  },
  'order_settings.updated': {
    params: { mode: 'human_approval', cod: 'enabled', approvalWindowHours: 24 },
    english:
      'Set order mode to "human_approval" (cash on delivery enabled, approval window 24h)',
  },
  'data_export.requested': {
    params: { exportId: 'exp-1' },
    english: 'Requested a full data export (exp-1)',
  },
  'data_export.downloaded': {
    params: { exportId: 'exp-1' },
    english: 'Downloaded the data export bundle exp-1',
  },
  'courier.connected': {
    params: { courier: 'aramex', accountRef: 'ACC-1' },
    english: 'Connected the aramex courier account ACC-1',
  },
  'courier.saved_inactive': {
    params: { courier: 'aramex', accountRef: 'ACC-1' },
    english: 'Saved (inactive) the aramex courier account ACC-1',
  },
  'courier.deactivated': {
    params: { connectionId: 'conn-1' },
    english: 'Deactivated courier connection conn-1',
  },
  'courier.webhook_secret_rotated': {
    params: { connectionId: 'conn-1' },
    english: 'Rotated the webhook secret for courier connection conn-1',
  },
  'shipment.recorded': {
    params: { courier: 'smsa', trackingNumber: 'TRK1', orderRef: 'ORD-1' },
    english: 'Recorded a smsa shipment (TRK1) for order ORD-1',
  },
  'delivery_notifications.enabled': {
    params: { mappedStatuses: 3 },
    english: 'Set proactive delivery notifications on with 3 mapped status(es)',
  },
  'delivery_notifications.disabled': {
    params: { mappedStatuses: 0 },
    english:
      'Set proactive delivery notifications off with 0 mapped status(es)',
  },
  'template_message.not_delivered': {
    params: { error: 'WhatsApp rejected the send (#132001)' },
    english:
      'Template message was not delivered: WhatsApp rejected the send (#132001)',
  },
  'workspace.closed': {
    params: { purgeAfter: '2026-11-04T00:00:00.000Z' },
    english:
      'Closed the workspace; data scheduled for erasure after 2026-11-04T00:00:00.000Z',
  },
  'workspace.reopened': {
    params: {},
    english: 'Reopened the workspace before its scheduled erasure',
  },
  'booking_settings.updated': {
    params: { mode: 'auto', timeZone: 'Asia/Riyadh' },
    english: 'Updated booking settings (mode auto, time zone Asia/Riyadh)',
  },
  'booking_service.created': {
    params: { serviceName: 'Cleaning' },
    english: 'Added the bookable service “Cleaning”',
  },
  'booking_service.updated': {
    params: { serviceName: 'Cleaning' },
    english: 'Edited the bookable service “Cleaning”',
  },
  'booking.created': {
    params: {
      bookingRef: 'BK-7Q2M9X',
      service: 'Cleaning',
      when: '2026-10-08 16:30',
    },
    english: 'Added booking BK-7Q2M9X: Cleaning on 2026-10-08 16:30',
  },
  'booking.confirmed': {
    params: { bookingRef: 'BK-7Q2M9X' },
    english: 'Confirmed booking BK-7Q2M9X',
  },
  'booking.cancelled': {
    params: { bookingRef: 'BK-7Q2M9X', reason: 'Customer asked' },
    english: 'Cancelled booking BK-7Q2M9X: Customer asked',
  },
  'booking.completed': {
    params: { bookingRef: 'BK-7Q2M9X' },
    english: 'Marked booking BK-7Q2M9X as done',
  },
  'booking.no_show': {
    params: { bookingRef: 'BK-7Q2M9X' },
    english: 'Marked booking BK-7Q2M9X as a no-show',
  },
  'calendar.connected': {
    params: { provider: 'google', account: 'clinic@example.com' },
    english: 'Connected Google Calendar (clinic@example.com)',
  },
  'calendar.disconnected': {
    params: { provider: 'google' },
    english: 'Disconnected Google Calendar',
  },
  'widget.updated': {
    params: { enabled: 'on', origins: '2' },
    english: 'Updated the website chat widget (on, 2 allowed website(s))',
  },
  'widget.key_rotated': {
    params: {},
    english: 'Issued a new website chat widget key',
  },
  'workspace.profile_updated': {
    params: { fields: 'currency, vertical' },
    english: 'Updated the workspace profile (currency, vertical)',
  },
  'kb_document.deleted': {
    params: { filename: 'refund-policy.pdf', chunkCount: 12 },
    english:
      'Deleted knowledge-base document "refund-policy.pdf" (12 retrieval chunk(s) removed)',
  },
  'segment.created': {
    params: { segmentName: 'VIPs' },
    english: 'Created segment "VIPs"',
  },
  'segment.updated': {
    params: { segmentId: 'seg-1' },
    english: 'Updated segment seg-1',
  },
  'segment.deleted': {
    params: { segmentId: 'seg-1' },
    english: 'Deleted segment seg-1',
  },
  'campaign.created': {
    params: { campaignName: 'Eid sale' },
    english: 'Created draft campaign "Eid sale"',
  },
  'campaign.edited': {
    params: { campaignName: 'Eid sale' },
    english: 'Edited draft campaign "Eid sale"',
  },
  'campaign.scheduled': {
    params: {
      campaignName: 'Eid sale',
      scheduledAt: '2026-10-10T09:00:00.000Z',
      recipientCount: 40,
    },
    english:
      'Scheduled campaign "Eid sale" for 2026-10-10T09:00:00.000Z to 40 recipient set',
  },
  'campaign.scheduled_immediate': {
    params: { campaignName: 'Eid sale', recipientCount: 0 },
    english:
      'Scheduled campaign "Eid sale" for immediate send to an unsnapshotted recipient set',
  },
  'campaign.paused': {
    params: { campaignName: 'Eid sale' },
    english: 'Paused campaign "Eid sale"',
  },
  'campaign.resumed': {
    params: { campaignName: 'Eid sale' },
    english: 'Resumed campaign "Eid sale"',
  },
  'campaign.canceled': {
    params: { campaignName: 'Eid sale' },
    english: 'Canceled campaign "Eid sale"',
  },
  'team.role_changed': {
    params: { email: 'agent@zenith.test', role: 'admin' },
    english: "Changed agent@zenith.test's role to admin",
  },
  'team.member_removed': {
    params: { userId: 'user-1', releasedTickets: 2 },
    english:
      'Removed member user-1 from the workspace (2 unresolved ticket(s) released)',
  },
  'customer.label_overridden': {
    params: { customerId: 'cust-1', label: 'hot' },
    english: 'Overrode customer cust-1\'s label to "hot"',
  },
  'customer.label_cleared': {
    params: { customerId: 'cust-1' },
    english:
      'Cleared the label override on customer cust-1, returning it to the agent',
  },
  'consent.opted_out': {
    params: { phone: '+966500000001' },
    english: "Recorded an opt-out for +966500000001 on the customer's behalf",
  },
  'consent.opted_in': {
    params: { phone: '+966500000001' },
    english: 'Recorded consent to message +966500000001 again',
  },
  'marketing_consent.opted_out': {
    params: { customerId: 'cust-1' },
    english: 'Recorded a marketing opt-out for customer cust-1',
  },
  'marketing_consent.cleared': {
    params: { customerId: 'cust-1' },
    english: 'Cleared the marketing opt-out for customer cust-1',
  },
};

describe('renderAuditDetail', () => {
  it.each(AUDIT_DETAIL_KEYS)(
    '%s renders the same English the handler wrote before keys existed',
    (key) => {
      const golden = GOLDEN[key];
      expect(renderAuditDetail(key, golden.params)).toBe(golden.english);
    },
  );

  it('covers every key in the catalogue with a golden string', () => {
    expect(Object.keys(GOLDEN).sort()).toEqual([...AUDIT_DETAIL_KEYS].sort());
  });
});
