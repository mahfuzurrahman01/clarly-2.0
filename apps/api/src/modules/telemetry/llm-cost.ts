// TelemetryModule (Feature 7, A8 "token + cost accounting"): per-model USD
// pricing, sourced (not fabricated) from Google's published Gemini API rates
// as of August 2026 — https://ai.google.dev/gemini-api/docs/pricing (see
// docs/decisions/F7-observability.md for the full citation). Deliberately
// approximate in one specific way: Gemini prices cached input tokens far
// cheaper than uncached ones, and `LlmUsage` (llm-provider.port.ts) doesn't
// currently distinguish the two — every input token here is priced at the
// (higher) uncached rate, so actual spend will typically run LOWER than what
// this reports, never higher. A future LlmUsage field for cached tokens would
// let this be exact instead of a safe upper bound.
interface ModelPricing {
  readonly usdPerMillionInputTokens: number;
  readonly usdPerMillionOutputTokens: number;
}

/** Models this table has real pricing for — anything else falls back to $0 (logged as a gap, never silently wrong) rather than guessing at a number for a model no cost data was sourced for. */
const PRICING: ReadonlyMap<string, ModelPricing> = new Map([
  [
    'gemini-3.5-flash-lite',
    { usdPerMillionInputTokens: 0.3, usdPerMillionOutputTokens: 2.5 },
  ],
  [
    'gemini-3.5-flash',
    { usdPerMillionInputTokens: 1.5, usdPerMillionOutputTokens: 9.0 },
  ],
]);

/**
 * Whether this table can actually price `model`. Exists so the "falls back to
 * $0" case can be reported instead of quietly zeroing out A8's cost
 * accounting: the LLM provider has already moved (Gemini -> Qwen on vLLM)
 * without this table moving with it, which means every `agent_runs.cost_usd`
 * written since that swap is 0 — indistinguishable, in the column itself,
 * from a genuinely free run. `estimateCostUsd()` stays a pure function;
 * callers decide how loudly to report the gap.
 */
export function isPricedModel(model: string): boolean {
  return PRICING.has(model);
}

export function estimateCostUsd(
  model: string,
  inputTokens: number,
  outputTokens: number,
): number {
  const pricing = PRICING.get(model);
  if (!pricing) return 0;

  const inputCost =
    (inputTokens / 1_000_000) * pricing.usdPerMillionInputTokens;
  const outputCost =
    (outputTokens / 1_000_000) * pricing.usdPerMillionOutputTokens;
  return inputCost + outputCost;
}
