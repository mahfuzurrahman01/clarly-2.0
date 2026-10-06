// P0.1: pin sampling temperature for eval runs only.
//
// WHY this file exists: three consecutive full-suite runs on IDENTICAL code
// produced resolution 96.2% / 93.3% / 96.2% with largely DIFFERENT cases
// failing each time. Part of that spread is the model sampling a different
// token at temperature > 0. Measurement noise we can remove costs nothing;
// noise we cannot remove has to be reported as a spread (see aggregate.ts).
//
// WHY a wrapper here instead of a setting in the provider: production must keep
// whatever sampling behaviour it has today. AgentRuntime never sets
// `temperature`, so the request omits the field and the serving host applies
// its own default. Changing that in src/ would change production behaviour to
// make a measurement convenient, which is backwards. Instead the eval process
// wraps the singleton LlmProvider instance it pulled out of the Nest container
// and defaults the field on the way past. Nothing in src/ is touched, and a
// normal API process is unaffected because this file is never imported by it.
//
// PROBED, not assumed (2026-08-16, `qwen3.6-35b-a3b` on vLLM at
// https://llm.arahim.dev/v1): the endpoint DOES honour `temperature` on
// tool-calling requests. Three `temperature: 0` calls with tools returned a
// byte-identical `tool_calls[0].function.arguments`; two calls with the field
// omitted returned three different answers. Caveat worth keeping in mind:
// greedy decoding removes sampling noise, not batching noise — vLLM's
// continuous batching can still change floating-point reduction order between
// requests, so temperature 0 narrows the spread rather than guaranteeing a
// bit-identical run. That is exactly why the harness still reports min–max.
import type {
  LlmCompleteRequest,
  LlmProvider,
  LlmToolRequest,
} from '../src/modules/llm/ports/llm-provider.port';

/** Greedy decoding. Not configurable per-run: a "pinned" run means one thing. */
export const EVAL_TEMPERATURE = 0;

/**
 * Escape hatch, off by default. `EVAL_PIN_TEMPERATURE=false` reproduces the
 * pre-P0.1 behaviour, which is the only way to measure how much of the spread
 * sampling was actually responsible for.
 */
export function temperaturePinningEnabled(): boolean {
  return process.env.EVAL_PIN_TEMPERATURE !== 'false';
}

/**
 * Defaults `temperature` on every request made through this provider INSTANCE.
 * An explicit temperature from a caller (the judge already sends 0) wins, so
 * this only fills the gap AgentRuntime leaves.
 */
export function pinTemperature(
  llm: LlmProvider,
  temperature: number = EVAL_TEMPERATURE,
): void {
  const complete = llm.complete.bind(llm);
  const completeWithTools = llm.completeWithTools.bind(llm);

  Object.assign(llm, {
    complete: (request: LlmCompleteRequest) =>
      complete({ ...request, temperature: request.temperature ?? temperature }),
    completeWithTools: (request: LlmToolRequest) =>
      completeWithTools({
        ...request,
        temperature: request.temperature ?? temperature,
      }),
  });
}

/**
 * The line that goes in the scorecard header. Recorded verbatim so a scorecard
 * read six months from now says what sampling regime produced it instead of
 * leaving the reader to guess.
 */
export function determinismNote(pinned: boolean): string {
  return pinned
    ? `LLM temperature PINNED to ${EVAL_TEMPERATURE} for this eval run (eval-only wrapper; ` +
        'production is unchanged and still sends no temperature). Probed 2026-08-16: this ' +
        'vLLM endpoint honours temperature on tool-calling requests — three temperature-0 ' +
        'tool calls returned byte-identical arguments, three unpinned calls did not. Greedy ' +
        'decoding does not make the host bit-deterministic (continuous batching can still ' +
        'reorder floating-point reductions), so a residual spread is expected, not a bug.'
    : 'LLM temperature NOT pinned (EVAL_PIN_TEMPERATURE=false): no temperature is sent, so ' +
        'the serving host applies its own sampling default and run-to-run variance includes ' +
        'sampling noise.';
}

/**
 * The LLM provider/model actually in force, for runs.json. Mirrors env.schema
 * defaults (LLM_PROVIDER=deepseek, LLM_MODEL/DEEPSEEK_MODEL=deepseek-v4-flash)
 * so an env that relies on defaults is still recorded as what it ran, not
 * "unknown".
 */
export function resolveLlmConfig(env: NodeJS.ProcessEnv): {
  llmProvider: string;
  llmModel: string;
} {
  const llmProvider = env.LLM_PROVIDER ?? 'deepseek';
  const llmModel =
    env.LLM_MODEL ??
    (llmProvider === 'deepseek'
      ? (env.DEEPSEEK_MODEL ?? 'deepseek-v4-flash')
      : 'unknown');
  return { llmProvider, llmModel };
}
