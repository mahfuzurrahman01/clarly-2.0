// AlertingModule (T18): per-tenant, unlike PlatformHealthAlert — "a live
// cross-tenant attack probe" is inherently tenant-scoped (which tenant's
// agent tried the out-of-scope tool call), so this stays a separate
// pipeline mirroring StuckTicketAlert/LatencyBudgetAlert rather than
// folding into the platform-level type.
export interface ToolScopeViolationAlert {
  tenantId: string;
  violationCount: number;
  threshold: number;
  windowMinutes: number;
}
