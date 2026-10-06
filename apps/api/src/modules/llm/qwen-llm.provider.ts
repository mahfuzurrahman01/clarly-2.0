// A0/D1: vLLM adapter for the LlmProvider port, selected via
// LLM_PROVIDER=qwen (see llm.module.ts's factory). Talks the
// OpenAI-compatible `/v1/chat/completions` surface vLLM serves, so nothing
// here is Qwen-specific beyond the defaults — any vLLM-hosted chat model
// works by pointing LLM_BASE_URL/LLM_MODEL elsewhere.
//
// Why this exists: GEMINI_API_KEY is one shared, rate-limited quota. The
// 2026-08-15 eval baseline failed 14 of 17 cases on `429` with an empty
// answer while recall@5 was 100% and hallucinations were 0 — i.e. the agent
// was quota-bound, not quality-bound. The Embedder already moved to
// self-hosted vLLM (QwenEmbedder); this moves chat too, taking the respond
// path off vendor rate limits entirely. GeminiProvider stays bound as the
// rollback path.
//
// Two properties of the served model, both probed against the live endpoint
// rather than assumed (2026-08-16, `Qwen/Qwen3.6-35B-A3B-FP8`, vLLM 0.26.0):
//
//  1. Tool calling WORKS. vLLM only parses tool calls when started with
//     `--enable-auto-tool-choice`, and it is enabled on this box: the real
//     `respond` contract came back as `finish_reason: tool_calls` with valid
//     JSON arguments and a correct citation. Without that flag the model
//     would emit tool calls as prose and the agent loop would silently never
//     see one — worth re-probing if the host is ever rebuilt.
//
//  2. Reasoning must be turned OFF. Qwen3.6 is a hybrid reasoning model and
//     thinks by default: same prompt, same correct answer, 278 completion
//     tokens / 1.78s with thinking vs 51 tokens / 0.74s without. Support
//     turns do not need deliberation, so `enable_thinking: false` is sent on
//     every call. If some future task genuinely needs it, make it an
//     explicit per-call option rather than paying it on every turn.
//
// The served model on this host is NOT pinned — the embedding host silently
// changed model (and vector width) mid-development. A chat-model swap is
// less immediately destructive than an embedding one (no corrupted index),
// but re-probe tool calling before trusting a changed model.
import { Injectable } from '@nestjs/common';
import { AppConfigService } from '../core';
import {
  OpenAiCompatibleLlmProvider,
  type OpenAiCompatibleProviderOptions,
} from './openai-compatible-llm.provider';

/**
 * The SDK requires a non-empty apiKey; this host serves an unauthenticated
 * endpoint (no `securitySchemes` in its OpenAPI spec), so there is no
 * credential to configure and nothing secret in this value.
 */
const UNAUTHENTICATED_PLACEHOLDER_KEY = 'not-required';

@Injectable()
export class QwenLlmProvider extends OpenAiCompatibleLlmProvider {
  constructor(config: AppConfigService) {
    super(qwenOptions(config, 'Qwen (vLLM)', false));
  }
}

/**
 * A11 (Feature 17) on the self-hosted box: VISION_PROVIDER=qwen. Qwen3.6-35B-A3B
 * is multimodal, so image turns run on the same host and model as text turns —
 * verified live 2026-09-29 (it named the Orbit V3 from the eval's product photo
 * in 1.4s). A separate binding only so it gets its own circuit breaker, exactly
 * like DeepSeekVisionProvider/GeminiVisionProvider.
 */
@Injectable()
export class QwenVisionProvider extends OpenAiCompatibleLlmProvider {
  constructor(config: AppConfigService) {
    super(qwenOptions(config, 'Qwen (vLLM, vision)', true));
  }
}

function qwenOptions(
  config: AppConfigService,
  vendorLabel: string,
  vision: boolean,
): OpenAiCompatibleProviderOptions {
  return {
    vendorLabel,
    apiKey: UNAUTHENTICATED_PLACEHOLDER_KEY,
    baseUrl: config.llmBaseUrl,
    model: config.llmModel,
    timeoutMs: config.llmRequestTimeoutMs,
    vision,
    extraBody: { chat_template_kwargs: { enable_thinking: false } },
    cfAccessHeaders: {
      clientId: config.cfAccessClientId,
      clientSecret: config.cfAccessClientSecret,
    },
  };
}
