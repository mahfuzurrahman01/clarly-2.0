import { notificationContent } from './notification-content';

/**
 * The console localises a notification from `kind` + `params` and falls back to
 * `title`/`body`. So every builder must put into `params` exactly the values its
 * English text interpolates, and the English text must stay what it was.
 */
describe('notificationContent', () => {
  it('order_pending_approval carries the order reference, count, total, currency and customer', () => {
    const content = notificationContent.orderPendingApproval({
      orderRef: 'ORD-AV96KJ',
      count: 1,
      total: '62.00',
      currency: 'SAR',
      customer: 'Riazul Islam',
    });

    expect(content).toEqual({
      kind: 'order_pending_approval',
      title: 'Order ORD-AV96KJ is waiting for approval',
      body: '1 item(s), 62.00 SAR, for Riazul Islam. Approve or reject it before the approval window closes.',
      params: {
        orderRef: 'ORD-AV96KJ',
        count: 1,
        total: '62.00',
        currency: 'SAR',
        customer: 'Riazul Islam',
      },
    });
  });

  it('ticket_stuck carries the unclaimed minutes and the threshold', () => {
    const content = notificationContent.ticketStuck({
      minutes: 42,
      thresholdMinutes: 15,
    });

    expect(content.kind).toBe('ticket_stuck');
    expect(content.title).toBe('A ticket has gone unanswered for 42 minutes');
    expect(content.body).toBe(
      'This conversation was handed to a human 42 minutes ago and nobody has picked it up. Your alert threshold is 15 minutes.',
    );
    expect(content.params).toEqual({ minutes: 42, thresholdMinutes: 15 });
  });

  it('latency_budget_exceeded rounds the p95 the same way the text does', () => {
    const content = notificationContent.latencyBudgetExceeded({
      windowMinutes: 15,
      p95Ms: 8123.6,
      budgetMs: 6000,
      sampleSize: 40,
    });

    expect(content.body).toBe(
      'Over the last 15 minutes, 95% of replies took under 8124ms against a 6000ms target (40 replies).',
    );
    expect(content.params).toEqual({
      windowMinutes: 15,
      p95Ms: 8124,
      budgetMs: 6000,
      sampleSize: 40,
    });
  });

  it('tool_scope_violations carries the count, window and threshold', () => {
    const content = notificationContent.toolScopeViolations({
      violationCount: 7,
      windowMinutes: 10,
      threshold: 5,
    });

    expect(content.body).toContain(
      '7 blocked tool calls in the last 10 minutes, past the threshold of 5.',
    );
    expect(content.params).toEqual({
      violationCount: 7,
      windowMinutes: 10,
      threshold: 5,
    });
  });

  it('trial_ending pluralises the English and carries the raw day count', () => {
    expect(notificationContent.trialEnding({ daysLeft: 1 })).toMatchObject({
      kind: 'trial_ending',
      title: 'Your Clarly trial ends in 1 day',
      params: { daysLeft: 1 },
    });
    expect(notificationContent.trialEnding({ daysLeft: 3 }).title).toBe(
      'Your Clarly trial ends in 3 days',
    );
  });

  it('trial_expired and payment_failed have no interpolated values', () => {
    expect(notificationContent.trialExpired()).toMatchObject({
      kind: 'trial_expired',
      title: 'Your Clarly trial has ended',
      params: {},
    });
    expect(notificationContent.paymentFailed()).toMatchObject({
      kind: 'payment_failed',
      title: 'Your Clarly subscription payment failed',
      params: {},
    });
  });

  it('campaign_paused distinguishes a campaign that never started', () => {
    const paused = notificationContent.campaignPaused({
      campaignName: 'Eid sale',
      pauseStatus: 'paused_spend_cap',
      reason: 'Spend cap reached.',
      remaining: 12,
    });
    expect(paused.title).toBe('Campaign "Eid sale" paused');
    expect(paused.body).toBe(
      'Spend cap reached. 12 recipient(s) have not been messaged; they stay queued until you resume or cancel the campaign.',
    );
    expect(paused.params).toEqual({
      campaignName: 'Eid sale',
      pauseStatus: 'paused_spend_cap',
      reason: 'Spend cap reached.',
      remaining: 12,
    });

    expect(
      notificationContent.campaignPaused({
        campaignName: 'Eid sale',
        pauseStatus: 'failed',
        reason: 'x',
        remaining: 0,
      }).title,
    ).toBe('Campaign "Eid sale" could not start');
  });

  it('order_store_push_failed truncates the provider error identically in text and params', () => {
    const longError = 'e'.repeat(400);
    const content = notificationContent.orderStorePushFailed({
      orderRef: 'ORD-1',
      error: longError,
    });
    expect(content.params).toEqual({
      orderRef: 'ORD-1',
      error: 'e'.repeat(300),
    });
    expect(content.body).toContain(`store: ${'e'.repeat(300)}. Retry`);
  });

  it('courier_connection_failing names its cause so the two variants can be told apart', () => {
    expect(
      notificationContent.courierCredentialsRejected({ courier: 'aramex' }),
    ).toMatchObject({
      kind: 'courier_connection_failing',
      title: 'aramex rejected your credentials',
      params: { courier: 'aramex', cause: 'credentials_rejected' },
    });
    expect(
      notificationContent.courierPollFailing({ courier: 'smsa', attempts: 5 }),
    ).toMatchObject({
      kind: 'courier_connection_failing',
      title: 'smsa tracking has been failing',
      params: { courier: 'smsa', cause: 'unreachable', attempts: 5 },
    });
  });

  it('shipment_template_unusable carries the raw shipment status, not the spaced English', () => {
    const content = notificationContent.shipmentTemplateUnusable({
      status: 'out_for_delivery',
      detail: 'no template is mapped',
    });
    expect(content.body).toBe(
      'Customers are not being told when a parcel reaches "out for delivery": no template is mapped',
    );
    expect(content.params).toEqual({
      status: 'out_for_delivery',
      detail: 'no template is mapped',
    });
  });
});
