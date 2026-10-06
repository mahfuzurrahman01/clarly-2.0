// A4/D6: the bounded loop's hard caps. Not tenant/env configurable —
// unlike AGENT_LOOP_DEADLINE_MS (a time budget, legitimately
// environment-dependent), these are structural bounds on the loop's shape
// and changing them is a code change, not a config change.
/**
 * Raised 2 → 3 on 2026-09-29. Evidence: the full-qwen eval's commerce-roundtrip-
 * cap corpus tripped this cap on 53% of turns, and the ~35 failing order turns
 * in commerce-journey/commerce-order mostly spent a round trip on a refused
 * `create_order` before the corrective one. A lookup, a refused attempt and the
 * real order is three trips. Still a hard structural bound - AGENT_LOOP_DEADLINE_MS
 * remains the real ceiling on time.
 */
export const MAX_TOOL_ROUND_TRIPS = 3;
/**
 * Raised 1 → 2 on 2026-08-16. Evidence: across four 126-161 case eval runs, 1-3
 * turns per run died as an `error_forced` LLM_ERROR after this budget was spent —
 * the single largest remaining failure bucket, and nondeterministic (a different
 * case each run, always one the model answers correctly on a retry). Two attempts
 * is still a hard bound, and AGENT_LOOP_DEADLINE_MS remains the real ceiling: a
 * slow model exhausts the wall clock long before it exhausts this counter.
 */
export const MAX_CORRECTIVE_RETRIES = 2;

/**
 * How far past AGENT_LOOP_DEADLINE_MS the loop may still START its one final
 * `respond` call once a tool has produced a result this turn (see
 * AgentRuntime.finalRespondAfterDeadline). Sized to one provider round trip
 * (~3-4s measured on deepseek-v4-flash, 2026-09-29) plus the tool execution
 * that overran the deadline. A structural bound like the two above — it buys
 * exactly one call, never a longer loop — so it is a constant, not config.
 */
export const FINAL_RESPOND_GRACE_MS = 6000;

/**
 * How much of the draft answer the grounding-override log line keeps. Enough
 * to see which claim the verifier rejected, short enough that a customer's
 * personal details quoted in the draft do not fill the log (2026-09-30).
 */
export const GROUNDING_DRAFT_LOG_CHARS = 600;
