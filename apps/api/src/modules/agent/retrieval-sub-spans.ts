// P0.3: maps RetrievalModule's phase timings onto the persisted
// agent_runs.spans keys.
//
// It lives here, in AgentModule, rather than in RetrievalModule because the
// span vocabulary belongs to telemetry, not to retrieval: RetrievalModule
// reports how long its own phases took and knows nothing about agent_runs,
// and AgentModule owns the decision about which of those phases is worth a
// persisted column. Keeping the translation in one named function also means
// the `agent_runs.spans` key names appear in exactly one place outside the
// schema file itself.
import type { AgentRunTelemetry } from './agent-run-telemetry';
import type { RetrievalPhaseTimings } from '../retrieval/retrieval-timings';

/**
 * Zero-valued phases are still passed through to addSpan(); the accumulator's
 * own "drop anything that stayed at 0" rule (see agent-run-telemetry.ts) is
 * what keeps them out of the persisted row, so "rerank was off" and "rerank
 * ran instantly" do not become the same record.
 */
export function recordRetrievalSubSpans(
  telemetry: AgentRunTelemetry,
  timings: RetrievalPhaseTimings | undefined,
): void {
  if (!timings) return;

  telemetry.addSpan('retrievalEmbedMs', timings.embedMs);
  if (timings.embedHttpTtfbMs !== undefined) {
    telemetry.addSpan('retrievalEmbedHttpTtfbMs', timings.embedHttpTtfbMs);
  }
  telemetry.addSpan('retrievalVectorQueryMs', timings.vectorQueryMs);
  telemetry.addSpan('retrievalLexicalQueryMs', timings.lexicalQueryMs);
  telemetry.addSpan('retrievalFusionMs', timings.fusionMs);
  telemetry.addSpan('retrievalRerankMs', timings.rerankMs);
}
