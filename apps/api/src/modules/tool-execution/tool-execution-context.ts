// The identity of the turn a tool call belongs to.
//
// Reconciliation note: two Phase 7 eng reviews independently specified this
// same seam under two names — F25 (`docs/decisions/F25-orders-in-chat.md`,
// D6.1) called it `ToolExecutionContext` with
// `{ tenantId, conversationId, customerId, turnId }`, F26
// (`docs/decisions/F26-delivery-tracking.md`, D4) called it
// `ToolCallerContext` with `{ tenantId, conversationId, customerId }`. It is
// one change, not two. The name kept is `ToolExecutionContext` (it belongs to
// `ToolExecutionService`, and the type lives in `tool-execution/` as both docs
// require) and the shape kept is F25's superset, since `turnId` is what makes
// F25's idempotency key stable across BullMQ retries and F26 needs nothing
// removed to work against it.
//
// Nullability is the second reconciliation: F25 wrote every field as a
// required `string`, but `AgentRuntime.respond()` has a real non-conversational
// caller today — `CommentReplyAgent` drafts a private reply to a public comment
// where no conversation and no customer exist yet (D15b). Rather than inventing
// a placeholder id (which would be an identity a tool could read), the three
// turn-scoped fields are explicitly nullable and every consumer must fail
// closed on null — which is exactly the rule F26's D4 already states for
// `TrackOrderExecutor` ("a context with no `customerId` returns the
// no-shipment payload, never an unscoped query").
export interface ToolExecutionContext {
  /**
   * Always present. Explicitly passed rather than read from ambient async
   * context for the reason documented on `ToolExecutionService.execute()`:
   * the tenant an executor's reads are scoped to must be the one the caller
   * authorized.
   */
  tenantId: string;
  /** The conversation this tool call is part of. Null for a non-conversational caller (comment reply, eval harness). */
  conversationId: string | null;
  /** The customer who is talking. Null for a non-conversational caller. Customer-scoped tools MUST return an empty/refusing result on null, never an unscoped query. */
  customerId: string | null;
  /**
   * Stable per respond-path job, unchanged across BullMQ retries — the
   * coalesced burst's own job id, never a freshly minted UUID, or a retry
   * would defeat any idempotency key derived from it (F25 D6.2 race #2).
   * Null for a non-conversational caller.
   */
  turnId: string | null;
  /**
   * What the customer has said (recent customer messages plus the current one),
   * so a tool can check that a value it was handed is the customer's own and
   * not something the model made up. Absent for callers that don't supply it;
   * a provenance check is skipped then, never failed.
   */
  customerText?: string;
}
