// AlertingModule (Feature 7/8, T18): platform-level alert types — no
// tenant scoping at all, unlike StuckTicketAlert/LatencyBudgetAlert/
// ToolScopeViolationAlert (each keyed to a specific tenant). One shared
// discriminated payload for these four, unlike the per-tenant alerts:
// they're all "is the platform itself healthy" checks that run on the
// same cadence, and a future notification channel (T18's own eventual
// delivery mechanism, still not built) subscribing to "any platform
// health issue" is a more natural shape than four separate subscriptions.
export type PlatformHealthAlertType =
  | 'circuit_breaker_open'
  | 'queue_dlq_depth'
  | 'tenant_count_threshold'
  | 'dependency_unreachable';

export interface PlatformHealthAlert {
  type: PlatformHealthAlertType;
  message: string;
  details: Record<string, string | number>;
}
