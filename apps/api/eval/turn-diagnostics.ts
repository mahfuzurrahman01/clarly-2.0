/**
 * Eval-only diagnostics: what the model drafted and what the A6 grounding
 * verifier was shown, per turn.
 *
 * Why: a turn the verifier overrides (or that D10 zeroes) reaches turns.jsonl
 * only as the generic handoff line, so a false override could not be told from
 * a correct catch. The runtime logs the draft at warn level, but the harness
 * runs Nest with `logger: ['error']`, so cycle 3b never captured those lines.
 * This records the same facts straight from the two shared singletons, exactly
 * the way tool-call-recorder.ts observes ToolExecutionService: wrap the method,
 * write to the recorder that is "current" for the turn, and never change what
 * the wrapped call returns. Nothing in src/ changes.
 */
import type { AnswerGroundingVerifierService } from '../src/modules/guardrail/answer-grounding-verifier.service';
import type { GroundingCheckInput } from '../src/modules/guardrail/answer-grounding';
import type {
  LlmProvider,
  LlmToolRequest,
  LlmToolResult,
} from '../src/modules/llm/ports/llm-provider.port';
import type { GroundingCheckRecord, ModelCallRecord } from './types';

/** Long enough to read a whole WhatsApp-sized draft and the head of a JSON tool result; bounded so turns.jsonl stays readable. */
const MAX_TEXT_CHARS = 1500;

function clip(text: string): string {
  return text.length > MAX_TEXT_CHARS
    ? `${text.slice(0, MAX_TEXT_CHARS)}…`
    : text;
}

export class TurnDiagnosticsRecorder {
  private grounding: GroundingCheckRecord[] = [];
  private modelCalls: ModelCallRecord[] = [];

  recordGrounding(input: GroundingCheckInput, verdict: string | null): void {
    this.grounding = [
      ...this.grounding,
      {
        verdict,
        answer: clip(input.answer),
        citedPassages: input.citedPassages.map(clip),
        uncitedPassageCount: (input.otherRetrievedPassages ?? []).length,
        toolResults: (input.toolResultPassages ?? []).map(clip),
      },
    ];
  }

  recordModelCall(result: LlmToolResult): void {
    this.modelCalls = [
      ...this.modelCalls,
      {
        content: result.content ? clip(result.content) : '',
        toolCalls: result.toolCalls.map((call) => ({
          name: call.name,
          input: call.input,
        })),
      },
    ];
  }

  groundingChecks(): GroundingCheckRecord[] {
    return this.grounding;
  }

  modelCallLog(): ModelCallRecord[] {
    return this.modelCalls;
  }
}

type CheckFn = AnswerGroundingVerifierService['check'];
type CompleteWithToolsFn = (request: LlmToolRequest) => Promise<LlmToolResult>;

/** Wraps the shared verifier and chat/vision providers; returns one unwrap function. */
export function instrumentTurnDiagnostics(
  verifier: AnswerGroundingVerifierService,
  providers: LlmProvider[],
  getCurrent: () => TurnDiagnosticsRecorder | null,
): () => void {
  const originalCheck = verifier.check.bind(verifier) as CheckFn;
  verifier.check = async (input) => {
    const result = await originalCheck(input);
    getCurrent()?.recordGrounding(input, result.verdict);
    return result;
  };

  const restores = providers.map((provider) => {
    const original = provider.completeWithTools.bind(
      provider,
    ) as CompleteWithToolsFn;
    provider.completeWithTools = async (request) => {
      const result = await original(request);
      getCurrent()?.recordModelCall(result);
      return result;
    };
    return () => {
      provider.completeWithTools = original;
    };
  });

  return () => {
    verifier.check = originalCheck;
    restores.forEach((restore) => restore());
  };
}
