// Root barrel for all `apps/api/src/modules/*` structural scaffolds.
// See AI_PIPELINE_PLAN.md "NestJS Module Boundaries" for ownership and the
// 4 enforced dependency rules referenced in each module's file comment.

// Platform
export * from './core/core.module';
export * from './persistence/persistence.module';
export * from './tenant-context/tenant-context.module';
export * from './observability/observability.module';
export * from './queue/queue.module';
export * from './storage/storage.module';
export * from './email/email.module';

// Channel
export * from './whatsapp/whatsapp.module';
// Feature 16: ChannelModule owns the channel-agnostic port + registries;
// MetaChannelModule is the Messenger/Instagram binding behind them.
export * from './channel/channel.module';
export * from './meta-channel/meta-channel.module';
export * from './whatsapp/connect/connect.module';
export * from './whatsapp/health/whatsapp-health.module';
export * from './webhook/webhook.module';
// Gulf T8 (F23): comment automation on FB posts and IG posts/Reels.
export * from './comments/comments.module';

// Agent, AI-engineer owned
export * from './agent/agent.module';
export * from './agent-config/agent-config.module';
export * from './prompt/prompt.module';
export * from './llm/llm.module';
export * from './retrieval/retrieval.module';
export * from './knowledge-base/knowledge-base.module';
export * from './tool-registry/tool-registry.module';
export * from './tool-execution/tool-execution.module';
export * from './guardrail/guardrail.module';

// Product shell
export * from './conversation/conversation.module';
export * from './customer/customer.module';
export * from './ticket/ticket.module';
export * from './kanban/kanban.module';
export * from './inbox/inbox.module';
export * from './templates/templates.module';
export * from './auth/auth.module';
export * from './alerting/alerting.module';
export * from './notifications/notifications.module';
export * from './outbound/outbound.module';
export * from './metrics/metrics.module';
export * from './onboarding/onboarding.module';
export * from './telemetry/telemetry.module';
export * from './outcomes/outcomes.module';
export * from './retention/retention.module';
export * from './billing/billing.module';
export * from './billing-lifecycle/billing-lifecycle.module';
export * from './audit/audit.module';
export * from './tenant-lifecycle/tenant-lifecycle.module';
export * from './data-export/data-export.module';
export * from './privacy/privacy.module';
export * from './catalog/catalog.module';
export * from './store/store.module';
export * from './campaign/campaign.module';
export * from './order/order.module';
export * from './courier/courier.module';

// Clarly 2.0 (docs/v2/ARCHITECTURE.md §4)
export * from './platform/platform.module';
export * from './booking/booking.module';
export * from './widget/widget.module';
