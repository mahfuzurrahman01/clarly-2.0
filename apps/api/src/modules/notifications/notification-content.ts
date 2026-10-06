// The wording of every tenant notification, and the values it interpolates.
//
// The console renders a notification in the operator's language from `kind` +
// `params`, and falls back to the stored English `title`/`body`. Those two must
// never drift apart, so both come from one builder per kind: the English text
// is written from exactly the values that go into `params`. A producer that
// wants a new sentence adds a builder here rather than formatting its own.
//
// `params` values are strings or numbers only. Enumerated values (a shipment
// status, a pause reason, a courier failure cause) are sent RAW so the console
// can translate them; free text that only exists in English (a provider error,
// a pause reason sentence) is sent as-is and shown as-is.
import type { NotificationKind } from '../persistence/drizzle/schema';

export type NotificationParams = Readonly<Record<string, string | number>>;

export interface NotificationContent {
  kind: NotificationKind;
  title: string;
  body: string;
  params: NotificationParams;
}

/** Same cap the store-push failure has always applied to the provider's message. */
const STORE_PUSH_ERROR_MAX = 300;

function plural(count: number, one: string, many: string): string {
  return count === 1 ? one : many;
}

export const notificationContent = {
  ticketStuck(params: {
    minutes: number;
    thresholdMinutes: number;
  }): NotificationContent {
    return {
      kind: 'ticket_stuck',
      title: `A ticket has gone unanswered for ${params.minutes} minutes`,
      body: `This conversation was handed to a human ${params.minutes} minutes ago and nobody has picked it up. Your alert threshold is ${params.thresholdMinutes} minutes.`,
      params: { ...params },
    };
  },

  latencyBudgetExceeded(params: {
    windowMinutes: number;
    p95Ms: number;
    budgetMs: number;
    sampleSize: number;
  }): NotificationContent {
    const p95Ms = Math.round(params.p95Ms);
    return {
      kind: 'latency_budget_exceeded',
      title: 'Your agent is replying more slowly than usual',
      body: `Over the last ${params.windowMinutes} minutes, 95% of replies took under ${p95Ms}ms against a ${params.budgetMs}ms target (${params.sampleSize} replies).`,
      params: { ...params, p95Ms },
    };
  },

  toolScopeViolations(params: {
    violationCount: number;
    windowMinutes: number;
    threshold: number;
  }): NotificationContent {
    return {
      kind: 'tool_scope_violations',
      title: 'Your agent tried to use tools it is not allowed to use',
      body: `${params.violationCount} blocked tool calls in the last ${params.windowMinutes} minutes, past the threshold of ${params.threshold}. The calls were blocked; this usually means a tool is configured for the agent but not enabled for your workspace.`,
      params: { ...params },
    };
  },

  trialEnding(params: { daysLeft: number }): NotificationContent {
    const days = `${params.daysLeft} ${plural(params.daysLeft, 'day', 'days')}`;
    return {
      kind: 'trial_ending',
      title: `Your Clarly trial ends in ${days}`,
      body: `Your trial ends in ${days}. Add a payment method before then so your AI agent keeps replying to customers without interruption.`,
      params: { ...params },
    };
  },

  trialExpired(): NotificationContent {
    return {
      kind: 'trial_expired',
      title: 'Your Clarly trial has ended',
      body: 'Your trial has ended and your AI agent has stopped replying to customers. Add a payment method to pick up right where you left off — nothing about your setup is lost.',
      params: {},
    };
  },

  paymentFailed(): NotificationContent {
    return {
      kind: 'payment_failed',
      title: 'Your Clarly subscription payment failed',
      body: 'Your latest payment did not go through. Your AI agent has been paused until you update your payment method. Please update your card to restore service — your setup and conversation history are preserved.',
      params: {},
    };
  },

  /** `pauseStatus` is the campaign status it moved to (`paused_*`), or `failed` for a campaign that never started. */
  campaignPaused(params: {
    campaignName: string;
    pauseStatus: string;
    reason: string;
    remaining: number;
  }): NotificationContent {
    const outcome =
      params.pauseStatus === 'failed' ? 'could not start' : 'paused';
    return {
      kind: 'campaign_paused',
      title: `Campaign "${params.campaignName}" ${outcome}`,
      body:
        `${params.reason} ` +
        `${params.remaining} recipient(s) have not been messaged; they stay queued until you resume or cancel the campaign.`,
      params: { ...params },
    };
  },

  orderPendingApproval(params: {
    orderRef: string;
    count: number;
    total: string;
    currency: string;
    customer: string;
  }): NotificationContent {
    return {
      kind: 'order_pending_approval',
      title: `Order ${params.orderRef} is waiting for approval`,
      body: `${params.count} item(s), ${params.total} ${params.currency}, for ${params.customer}. Approve or reject it before the approval window closes.`,
      params: { ...params },
    };
  },

  /** Clarly 2.0 S2. */
  bookingRequested(params: {
    bookingRef: string;
    service: string;
    when: string;
    customer: string;
  }): NotificationContent {
    return {
      kind: 'booking_requested',
      title: `Booking ${params.bookingRef} is waiting for confirmation`,
      body: `${params.service} on ${params.when} for ${params.customer}. Confirm or cancel it in Bookings, and let the customer know.`,
      params: { ...params },
    };
  },

  /** Clarly 2.0 S2. */
  calendarNeedsReconnect(params: { account: string }): NotificationContent {
    return {
      kind: 'calendar_needs_reconnect',
      title: 'Reconnect your Google Calendar',
      body: `Google stopped accepting the connection for ${params.account}. New bookings are recorded as requests until you reconnect it in Settings → Bookings.`,
      params: { ...params },
    };
  },

  orderStorePushFailed(params: {
    orderRef: string;
    error: string;
  }): NotificationContent {
    const error = params.error.slice(0, STORE_PUSH_ERROR_MAX);
    return {
      kind: 'order_store_push_failed',
      title: `Order ${params.orderRef} could not be sent to your store`,
      body: `The order is confirmed in Clarly and the customer has been told. It has not reached your store: ${error}. Retry it from the order, or enter it in your store by hand.`,
      params: { orderRef: params.orderRef, error },
    };
  },

  courierCredentialsRejected(params: { courier: string }): NotificationContent {
    return {
      kind: 'courier_connection_failing',
      title: `${params.courier} rejected your credentials`,
      body: `Delivery tracking for ${params.courier} is switched off until the credentials are re-entered. Customers asking where their order is will get stale information until then.`,
      params: { courier: params.courier, cause: 'credentials_rejected' },
    };
  },

  courierPollFailing(params: {
    courier: string;
    attempts: number;
  }): NotificationContent {
    return {
      kind: 'courier_connection_failing',
      title: `${params.courier} tracking has been failing`,
      body: `We have not been able to reach ${params.courier} for ${params.attempts} attempts in a row. Delivery statuses shown to customers may be out of date.`,
      params: {
        courier: params.courier,
        cause: 'unreachable',
        attempts: params.attempts,
      },
    };
  },

  shipmentTemplateUnusable(params: {
    status: string;
    detail: string;
  }): NotificationContent {
    return {
      kind: 'shipment_template_unusable',
      title: 'A shipment update could not be sent',
      body: `Customers are not being told when a parcel reaches "${params.status.replace(/_/g, ' ')}": ${params.detail}`,
      params: { ...params },
    };
  },
} as const;
