// A0/D1: the Gemini LlmProvider adapter. Talks Gemini's OpenAI-compatible
// chat-completions + function-calling API (`/v1beta/openai`) via the
// `openai` SDK pointed at LLM_BASE_URL — not a bespoke HTTP client, and not
// an Anthropic adapter (D1: "do not stand one up 'just in case'").
//
// Gemini replaced DeepSeek as the LLM vendor so one credential served both
// this port and the Embedder port (DeepSeek serves no embeddings endpoint at
// all). Verified live 2026-08-15: this endpoint returns real `tool_calls`
// (A4's agent loop) and a populated `usage` block (A8's token accounting).
// The Embedder has since moved to self-hosted vLLM, and QwenLlmProvider is
// now the default chat adapter — this one remains the rollback path
// (LLM_PROVIDER=gemini), which is why it is not deleted.
//
// All response/error mapping lives in OpenAiCompatibleLlmProvider; the only
// Gemini-specific thing left here is the credential. Note Gemini also emits
// `extra_content.google.thought_signature` on tool calls, which the base
// class captures and replays verbatim.
import { Injectable } from '@nestjs/common';
import { AppConfigService } from '../core';
import { OpenAiCompatibleLlmProvider } from './openai-compatible-llm.provider';

@Injectable()
export class GeminiProvider extends OpenAiCompatibleLlmProvider {
  constructor(config: AppConfigService) {
    super({
      vendorLabel: 'Gemini',
      apiKey: config.geminiApiKey,
      baseUrl: config.llmBaseUrl,
      model: config.llmModel,
      timeoutMs: config.llmRequestTimeoutMs,
    });
  }
}
