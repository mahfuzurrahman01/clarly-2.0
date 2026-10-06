// A4/A8: a small mutable accumulator threaded through one respond() call's
// lifetime — token usage (summed across every LLM call in the turn,
// including retries/corrective round-trips) and per-stage span timing.
// Deliberately mutable (not the immutable-by-default pattern used
// elsewhere in this codebase): it exists only within the scope of a
// single respond() invocation, is never shared across turns or read
// concurrently, and threading an immutable accumulator through
// AgentRuntime's already-deep call chain (runLoop -> handleRespondCall /
// handleToolRoundTrip -> callProviderWithRetry) would mean every one of
// those methods returning a new telemetry snapshot alongside its actual
// result — a lot of ceremony for what's fundamentally a stopwatch +
// counter. Same category of justified exception as `Clock`/`Sleep`
// themselves (stateful by nature, injected rather than threaded as data).
import type { LlmUsage } from '../llm/ports/llm-provider.port';
import type { AgentRunSpans } from '../persistence/drizzle/agent-runs.table';

export class AgentRunTelemetry {
  private inputTokensTotal = 0;
  private outputTokensTotal = 0;
  private readonly spanTotalsMs: Required<AgentRunSpans> = {
    retrievalMs: 0,
    llmMs: 0,
    toolExecutionMs: 0,
    guardrailMs: 0,
    // A6's grounding check — an LLM round trip, so deliberately NOT folded
    // into guardrailMs (see agent-runs.table.ts). Zero when the check was
    // skipped, and dropped like every other zero span.
    groundingMs: 0,
    // A11/A12's media stage (ASR / vision pre-pass). Another network call, so
    // it gets its own key for the same reason groundingMs does — and stays 0
    // (and therefore absent) on every text turn.
    mediaMs: 0,
    // P0.3 sub-spans of retrievalMs. Same accumulate-then-drop-zeros rule as
    // the four above: a phase that never ran (rerank off, or an Embedder that
    // reports no HTTP split) leaves no key behind rather than claiming 0ms.
    retrievalEmbedMs: 0,
    retrievalEmbedHttpTtfbMs: 0,
    retrievalVectorQueryMs: 0,
    retrievalLexicalQueryMs: 0,
    retrievalFusionMs: 0,
    retrievalRerankMs: 0,
  };

  addUsage(usage: LlmUsage): void {
    this.inputTokensTotal += usage.inputTokens;
    this.outputTokensTotal += usage.outputTokens;
  }

  addSpan(name: keyof AgentRunSpans, ms: number): void {
    this.spanTotalsMs[name] += ms;
  }

  get inputTokens(): number {
    return this.inputTokensTotal;
  }

  get outputTokens(): number {
    return this.outputTokensTotal;
  }

  /** Only includes spans that actually happened this turn — a KBNotIndexed short-circuit never reaches an LLM call, and the resulting agent_runs row shouldn't claim `llmMs: 0` as if a call was made and happened to take no time. */
  get spans(): AgentRunSpans {
    const spans: AgentRunSpans = {};
    for (const [key, value] of Object.entries(this.spanTotalsMs)) {
      if (value > 0) spans[key as keyof AgentRunSpans] = value;
    }
    return spans;
  }
}
