// A6/D12 (2026-08-17): the DI half of the answer-grounding net. Everything
// judgement-shaped (prompt, verdict grammar, why the check exists at all) is in
// answer-grounding.ts; this class only makes the call and refuses to let it hurt
// the turn.
//
// Three properties this service must hold, in order of importance:
//
//  1. FAIL OPEN. A verifier that throws, times out, or hedges must leave the
//     turn exactly as the agent produced it. This net exists to catch a
//     narrow class of missed escalations; a verifier outage must never become
//     an escalation storm (every turn to a human) or a lost turn.
//  2. NEVER inside the agent's own conversation. It is a separate `complete()`
//     call with its own system prompt — the checked model never sees the
//     verdict, cannot argue with it, and cannot be steered by the customer's
//     message into influencing it beyond the text being judged.
//  3. Its cost is visible. Tokens are added to the turn's telemetry by the
//     caller (AgentRuntime), so this call shows up in agent_runs like any
//     other, rather than being spend nobody can account for.
import { Injectable } from '@nestjs/common';
import { AppLoggerService } from '../core';
import { LlmProvider } from '../llm/ports/llm-provider.port';
import type { LlmUsage } from '../llm/ports/llm-provider.port';
import {
  buildGroundingMessages,
  parseGroundingVerdict,
  type GroundingCheckInput,
  type GroundingVerdict,
} from './answer-grounding';

export interface GroundingCheckResult {
  /** null = no opinion (call failed, or the reply was not a single unambiguous verdict). The caller must treat null as "leave the turn alone". */
  verdict: GroundingVerdict | null;
  /** Reported even when the verdict is null — a failed call can still have cost tokens, and A8's accounting must not lose them. */
  usage: LlmUsage;
}

/**
 * Room for the three check lines plus the verdict line (cycle 3b: ~120-200
 * tokens measured on Qwen). A reply cut off before its VERDICT line has no
 * opinion and fails open, so this errs on the generous side.
 */
const MAX_VERDICT_TOKENS = 400;

const ZERO_USAGE: LlmUsage = { inputTokens: 0, outputTokens: 0 };

@Injectable()
export class AnswerGroundingVerifierService {
  constructor(
    private readonly llmProvider: LlmProvider,
    private readonly logger: AppLoggerService,
  ) {}

  async check(input: GroundingCheckInput): Promise<GroundingCheckResult> {
    if (
      input.citedPassages.length === 0 &&
      (input.toolResultPassages ?? []).length === 0
    ) {
      // Nothing was cited and no tool ran, so there is no grounding to check.
      // D10's zero-citation override already owns this case.
      return { verdict: null, usage: ZERO_USAGE };
    }

    try {
      const result = await this.llmProvider.complete({
        messages: buildGroundingMessages(input),
        maxTokens: MAX_VERDICT_TOKENS,
        // A guard must not change its mind between two identical turns.
        // Production's agent calls deliberately send no temperature; this
        // one does, because it is a check rather than a reply.
        temperature: 0,
      });

      const verdict = parseGroundingVerdict(result.content);
      if (!verdict) {
        this.logger.warn(
          `grounding check returned no parseable verdict (stopReason=${result.stopReason}); treating as no opinion`,
          'AnswerGroundingVerifierService',
        );
      }
      return { verdict, usage: result.usage };
    } catch (error) {
      // Deliberately swallowed, not rethrown: see property 1 above. The
      // provider's own circuit breaker (D2) and retry policy have already run
      // by the time this lands here, so there is nothing left to retry.
      const message = error instanceof Error ? error.message : String(error);
      this.logger.warn(
        `grounding check failed (${message}); leaving the turn unchanged`,
        'AnswerGroundingVerifierService',
      );
      return { verdict: null, usage: ZERO_USAGE };
    }
  }
}
